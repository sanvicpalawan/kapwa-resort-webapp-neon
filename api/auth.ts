/**
 * Same-origin proxy for Neon Auth.
 *
 * Why a function rather than a rewrite: Neon Auth reconstructs the incoming
 * request host from `X-Forwarded-Host` and validates it against its OWN
 * hostname:
 *
 *   X-Forwarded-Host absent        -> 200
 *   X-Forwarded-Host = auth host   -> 200
 *   X-Forwarded-Host = app host    -> 400 INVALID_HOSTNAME
 *
 * A rewrite to an external origin always injects the app's own host, so it
 * fails unconditionally, and registering the app domain as a trusted domain
 * does not help because the check is against the auth host, not the allowlist.
 * A function receives the request before those proxy headers exist and
 * forwards it itself, so it can set X-Forwarded-Host correctly.
 *
 * Same-origin is also required for a second reason: Neon Auth signs its session
 * cookie `SameSite=None; Partitioned`. Hitting the auth host directly makes that
 * a third-party cookie, which browsers block by default — sign-in then succeeds
 * but GET /token receives no cookie and answers 401. Through this proxy the
 * cookie is first-party and replays normally.
 *
 * Why the target path arrives as a query parameter instead of a route param:
 * this project's catch-all (`[...path].ts`) only ever matched a single segment,
 * so `/api/auth/sign-in/email` fell through to Vercel's edge 404. Fixing the
 * routing is not worth fighting; the target is passed explicitly instead, which
 * matches regardless of segment count.
 *
 * Handler shape: Vercel's Node.js runtime passes a Node
 * `IncomingMessage`/`ServerResponse` pair, not a Web `Request` plus `context`.
 * So `req.url` is relative ("/api/auth?..."), `req.headers` is a plain object,
 * and an already-parsed `req.body` must be re-serialized.
 */

const AUTH_BASE = process.env.NEON_AUTH_BASE_URL ?? '';
const ENTRY = '/api/auth';
const PATH_PARAM = '__path';

// Headers describing *this* hop. Forwarding them would tell Neon Auth the
// request arrived at the app host — the rejection above. `Host` is recomputed
// by fetch from the target URL.
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-for',
  'x-vercel-id',
  'forwarded',
  'connection',
  'content-length',
  'accept-encoding',
]);

// Owned by the upstream response; duplicating them corrupts the body (stale
// content-length, double content-encoding).
const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

interface NodeReq {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface NodeRes {
  statusCode: number;
  setHeader(name: string, value: string | string[]): void;
  end(body?: string | Buffer): void;
}

function fail(res: NodeRes, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

export default async function handler(req: NodeReq, res: NodeRes): Promise<void> {
  if (!AUTH_BASE) {
    fail(res, 500, { error: 'NEON_AUTH_BASE_URL is not set' });
    return;
  }

  const incoming = new URL(req.url ?? ENTRY, 'http://127.0.0.1');
  const target = new URL(
    AUTH_BASE.endsWith('/') ? AUTH_BASE : `${AUTH_BASE}/`,
  );

  // `__path` carries the upstream route ("sign-in/email", "token", ...).
  const subPath = incoming.searchParams.get(PATH_PARAM) ?? '';
  incoming.searchParams.delete(PATH_PARAM);

  const segments = subPath.split('/').filter(Boolean);
  if (segments.length) {
    target.pathname = target.pathname.replace(/\/$/, '') + '/' + segments.map(encodeURIComponent).join('/');
  }

  // Preserve the remaining query string; the auth routes use it for redirects.
  incoming.searchParams.forEach((value, key) => target.searchParams.append(key, value));

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || DROP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  // The one header an external rewrite could not get right.
  headers.set('X-Forwarded-Host', new URL(AUTH_BASE).host);

  const method = (req.method ?? 'GET').toUpperCase();
  const init: RequestInit = { method, headers, redirect: 'manual' };
  if (method !== 'GET' && method !== 'HEAD') {
    // The Node runtime already parsed the JSON body, so re-serialize it rather
    // than trying to read a stream that has been consumed.
    init.body = req.body === undefined ? null : JSON.stringify(req.body);
    if (init.body !== null && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    fail(res, 502, { error: 'auth upstream unreachable', detail: String(err) });
    return;
  }

  for (const [key, value] of Object.entries(Object.fromEntries(upstream.headers.entries()))) {
    if (DROP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    // fetch collapses multiple Set-Cookie into one comma-joined value, which
    // browsers reject; getSetCookie() recovers them individually.
    if (key.toLowerCase() === 'set-cookie') continue;
    res.setHeader(key, value);
  }
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length) res.setHeader('set-cookie', cookies);

  res.statusCode = upstream.status;
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf.length ? buf : undefined);
}

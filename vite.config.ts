import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const authBase = env.NEON_AUTH_BASE_URL;

  // Neon Auth signs its session cookie `SameSite=None; Partitioned`. Served
  // from its own host that cookie is a THIRD-PARTY cookie, and browsers block
  // those by default — sign-in then succeeds but `GET /token` receives no
  // cookie and answers 401. There is no header or query alternative; /token is
  // cookie-only.
  //
  // Proxying makes the request same-origin, so the cookie becomes first-party
  // and is stored and replayed normally. The path prefix is stripped so the
  // auth service still sees /sign-in/email, /token, etc.
  const authProxy = authBase
    ? {
        // Mirrors api/auth.ts so local and production resolve identically.
        // The route travels in `__path` (see api/auth.ts for why) and has to be
        // turned back into an upstream path here.
        "^/api/auth/?$": {
          target: authBase,
          changeOrigin: true,
          secure: true,
          rewrite: (p: string) => {
            const qs = p.split("?")[1] ?? "";
            const params = new URLSearchParams(qs);
            const sub = (params.get("__path") ?? "").split("/").filter(Boolean);
            params.delete("__path");
            const suffix = sub.map(encodeURIComponent).join("/");
            const rest = params.toString();
            const base = authBase.endsWith("/") ? authBase : authBase + "/";
            return (suffix ? base + suffix : base) + (rest ? "?" + rest : "");
          },
          cookieDomainRewrite: "",
          cookiePathRewrite: "/",
          // Neon Auth rejects any X-Forwarded-Host that is not its own host,
          // so it must not be forwarded as the app's host.
          headers: { "X-Forwarded-Host": new URL(authBase).host },
        },
      }
    : {};

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
      proxy: authProxy,
    },
    preview: {
      port: 8080,
      proxy: authProxy,
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      dedupe: ["react", "react-dom", "react/jsx-runtime"],
    },
  };
});

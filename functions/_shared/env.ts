/**
 * Process-environment accessor.
 *
 * The original Supabase edge functions run on Deno, where configuration is read
 * through `Deno.env.get()`. Neon Functions run on Node.js 24 and read
 * `process.env`. Porting ~40 call sites by hand would be noisy and easy to get
 * wrong, so the bodies keep their original shape and every `Deno.env.get("X")`
 * becomes `env("X")`.
 *
 * Neon injects the infrastructure variables at runtime (DATABASE_URL,
 * NEON_AUTH_BASE_URL, NEON_AUTH_JWKS_URL, NEON_DATA_API_URL); application
 * secrets arrive as ordinary Function env.
 */
export const env = (key: string): string | undefined => process.env[key];

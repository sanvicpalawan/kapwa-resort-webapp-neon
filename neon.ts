import { defineConfig } from "@neon/config/v1";

// Per-function secrets, shared by every AI endpoint. Declared here so a deploy
// can never leave one of them half-configured, and read from the file passed to
// `neon deploy --env <file>`.
//
// The service identity is how these functions reach the database: they sign in
// through Neon Auth and act as a member of `employees` with the `admin`
// permission, rather than holding a bypass-RLS key. See functions/_shared/db.ts.
//
// OPENROUTER_API_KEY is deliberately NOT declared — the model gateway prefers
// `settings.openrouter_api_key`, which Admin → Agent Settings writes, so the
// key is configured in the app rather than baked into a deployment.
const aiEnv = {
  NEON_SERVICE_EMAIL: process.env.NEON_SERVICE_EMAIL!,
  NEON_SERVICE_PASSWORD: process.env.NEON_SERVICE_PASSWORD!,
  NEON_SERVICE_ORIGIN: process.env.NEON_SERVICE_ORIGIN!,
  APP_URL: process.env.APP_URL!,
};

export default defineConfig({
  // Declare your Neon services here
  auth: true,
  dataApi: true,
  // aiGateway omitted: not available on the Free plan. The app's AI calls
  // OpenRouter directly (OPENROUTER_API_KEY), so nothing is lost.
  functions: {
    hello: { name: "Hello World", source: "./hello.ts" },
    // The AI layer, ported from supabase/functions. Slugs are the functions'
    // permanent identity and appear in the invocation URL, so they are fixed at
    // the first deploy and cannot be renamed afterwards — the hyphenated
    // Supabase names are not valid here (slugs match ^[a-z0-9]{1,20}$), and the
    // web app maps its original names onto these in client.ts.
    //
    // guest-chat is reachable from the public Guest Portal; the rest are
    // back-office endpoints gated by requireStaff/requireAdmin against the
    // caller's own Neon Auth token.
    guestchat: { name: "TALA guest concierge", source: "./functions/guestchat/index.ts", env: aiEnv },
    resortop: { name: "Back-office operator agent", source: "./functions/resortop/index.ts", env: aiEnv },
    resortexec: { name: "Operator action executor", source: "./functions/resortexec/index.ts", env: aiEnv },
    scanreceipt: { name: "Receipt OCR", source: "./functions/scanreceipt/index.ts", env: aiEnv },
    opscoord: { name: "Operational brief", source: "./functions/opscoord/index.ts", env: aiEnv },
  },
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});

/**
 * Is this process the throwaway GATE PREVIEW? Preview-only behaviour (owner sign-in without a login token, demo seeding) must never
 * be reachable in production through one misconfigured variable, so a single flag is not enough. ALL of these must hold:
 *   1. APP_ENV is exactly "preview";
 *   2. the database is one of the throwaway preview databases ("seed" / "preview") - production's database is never named so;
 *   3. APP_URL points at the gate's internal host "preview";
 *   4. no production marker is present (AGENTS_PROJECTS / APP_ALLOWED_HOSTS / a real APP_BUILD_ID are set only by the production executor).
 * Any doubt (unparsable URL, missing variable) means: not a preview.
 */
export function previewMode(env: Record<string, string | undefined> = process.env): boolean {
  if (env.APP_ENV !== "preview") return false;
  if (env.AGENTS_PROJECTS || env.APP_ALLOWED_HOSTS || (env.APP_BUILD_ID && env.APP_BUILD_ID !== "dev")) return false;
  try {
    const db = new URL(env.DATABASE_URL ?? "");
    if (!["seed", "preview"].includes(db.pathname.replace(/^\//, ""))) return false;
    if (new URL(env.APP_URL ?? "").hostname !== "preview") return false;
  } catch {
    return false;
  }
  return true;
}

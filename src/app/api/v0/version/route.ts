export const dynamic = "force-dynamic";

/** Build identity of the running server (used by open tabs to detect a redeploy). Not sensitive; no session required. */
export function GET() {
  return Response.json({ build: process.env.APP_BUILD_ID ?? "dev" }, { headers: { "Cache-Control": "no-store" } });
}

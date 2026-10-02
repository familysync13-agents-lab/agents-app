import { isOwner } from "@/server/auth";
import { stateSnapshot } from "@/server/queries";

export const dynamic = "force-dynamic";

/** Read-only authoritative state (for the future Agent Operations Interface). No write path exists behind it. */
export async function GET() {
  if (!(await isOwner())) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(await stateSnapshot(), { headers: { "Cache-Control": "no-store" } });
}

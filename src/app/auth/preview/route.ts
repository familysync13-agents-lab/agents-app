import { NextResponse } from "next/server";
import { previewMode } from "@/server/preview-mode";
import { createPreviewSession, SESSION_COOKIE } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * Owner sign-in for the GATE PREVIEW ONLY (see previewMode(): APP_ENV=preview AND a throwaway preview database AND no production marker; a throwaway database on the gate's internal network, reachable only by
 * the gate's probes and oracles). In every other environment this route does not exist (404); production is started by the executor
 * with APP_ENV=production.
 */
export async function GET() {
  if (!previewMode()) return new NextResponse("Not found", { status: 404 });
  const sid = await createPreviewSession();
  const res = new NextResponse(null, { status: 303, headers: { Location: "/", "Cache-Control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, sid, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 3600, secure: false });
  return res;
}

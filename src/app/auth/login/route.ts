import { NextResponse, type NextRequest } from "next/server";
import { exchangeLoginToken, SESSION_COOKIE } from "@/server/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const sid = await exchangeLoginToken(token);
  // relative Location: stay on the exact loopback origin the owner opened (the session cookie is host-only)
  const res = new NextResponse(null, { status: 303, headers: { Location: sid ? "/" : "/signed-out", "Cache-Control": "no-store" } });
  if (sid) res.cookies.set(SESSION_COOKIE, sid, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 7 * 86400, secure: false });
  return res;
}

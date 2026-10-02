import { NextResponse, type NextRequest } from "next/server";

/*
 * Loopback control plane: refuse any request whose Host is not the configured loopback origin (DNS-rebinding defence) and any
 * state-changing request whose Origin is foreign (in addition to Next.js' own Server Action origin check).
 */
const defaults = process.env.APP_ENV === "preview" ? "preview:8080,localhost:8080" : "127.0.0.1:3700,localhost:3700";
const allowed = (process.env.APP_ALLOWED_HOSTS ?? defaults).split(",").map((s) => s.trim().toLowerCase());

export function proxy(req: NextRequest) {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (req.nextUrl.pathname === "/healthz" || req.nextUrl.pathname === "/api/v0/version") return NextResponse.next();
  if (!allowed.includes(host)) return new NextResponse("Forbidden host", { status: 403 });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.get("origin");
    if (origin && !allowed.some((h) => origin.toLowerCase() === `http://${h}`)) return new NextResponse("Forbidden origin", { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };

import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok", env: process.env.APP_ENV ?? "production", build: process.env.APP_BUILD_ID ?? "dev" });
  } catch {
    return Response.json({ status: "db-unavailable" }, { status: 503 });
  }
}

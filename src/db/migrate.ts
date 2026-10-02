import path from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "./client";

const MIGRATIONS = path.resolve(process.cwd(), "drizzle");

/** Applies the drizzle-kit generated SQL migrations (idempotent). */
export async function migrate(db: Db, url: string): Promise<void> {
  if (url.startsWith("pglite://")) {
    const { migrate: m } = await import("drizzle-orm/pglite/migrator");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await m(db as any, { migrationsFolder: MIGRATIONS });
  } else {
    const { migrate: m } = await import("drizzle-orm/node-postgres/migrator");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await m(db as any, { migrationsFolder: MIGRATIONS });
  }
  await db.execute(sql`select 1`);
}

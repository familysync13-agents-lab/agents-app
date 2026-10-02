import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let cached: Promise<Db> | undefined;

/**
 * DATABASE_URL:
 *   postgres://...        - production (node-postgres pool)
 *   pglite://<dir>        - local development/tests (embedded PostgreSQL, same SQL semantics)
 *   pglite://memory       - ephemeral (tests)
 */
export async function createDb(url: string): Promise<Db> {
  if (url.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const where = url.slice("pglite://".length);
    const client = where === "memory" ? new PGlite() : new PGlite(where);
    return drizzle(client, { schema }) as unknown as Db;
  }
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({ connectionString: url, max: 5 });
  return drizzle(pool, { schema }) as unknown as Db;
}

export function getDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  cached ??= createDb(url);
  return cached;
}

export { schema };

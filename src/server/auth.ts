import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { loginTokens, ownerSessions } from "@/db/schema";

/*
 * Owner authentication for a loopback-only control plane. The host daemon (which runs as the owner on the owner's Mac) mints a
 * one-time token, stores only its hash, and opens the login URL in the owner's browser. The session cookie is httpOnly and
 * SameSite=Strict; only its hash is stored. No password, no credential in the app.
 */
export const SESSION_COOKIE = "agents_session";
const SESSION_DAYS = 7;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export async function exchangeLoginToken(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const db = await getDb();
  const now = new Date();
  const used = await db
    .update(loginTokens)
    .set({ usedAt: now })
    .where(and(eq(loginTokens.tokenHash, hash(token)), isNull(loginTokens.usedAt), gt(loginTokens.expiresAt, now)))
    .returning({ h: loginTokens.tokenHash });
  if (used.length !== 1) return null;
  const sid = randomBytes(32).toString("base64url");
  await db.insert(ownerSessions).values({ idHash: hash(sid), expiresAt: new Date(now.getTime() + SESSION_DAYS * 86400_000) });
  return sid;
}

/** Gate preview only (see /auth/preview): a short owner session in a throwaway preview database. */
export async function createPreviewSession(): Promise<string> {
  if (process.env.APP_ENV !== "preview") throw new Error("preview sessions exist only in the gate preview");
  const db = await getDb();
  const sid = randomBytes(32).toString("base64url");
  await db.insert(ownerSessions).values({ idHash: hash(sid), expiresAt: new Date(Date.now() + 3600_000) });
  return sid;
}

export async function isOwner(): Promise<boolean> {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sid || sid.length > 200) return false;
  const db = await getDb();
  const [s] = await db
    .select({ h: ownerSessions.idHash })
    .from(ownerSessions)
    .where(and(eq(ownerSessions.idHash, hash(sid)), gt(ownerSessions.expiresAt, new Date())));
  return !!s;
}

export async function requireOwner(): Promise<void> {
  if (!(await isOwner())) redirect("/signed-out");
}

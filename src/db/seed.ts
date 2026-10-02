import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./client";
import { projects } from "./schema";

const ProjectConfig = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(4000),
  org: z.string().min(1),
  repo: z.string().regex(/^[A-Za-z0-9._-]+$/),
  ownerLogin: z.string().regex(/^[A-Za-z0-9-]+$/),
  builderKey: z.string().regex(/^[a-z0-9]{2,8}$/),
  stack: z.string().min(1).max(4000),
  interfaceTasks: z.array(z.string().regex(/^T[0-9]+$/)).default([]),
  workerDocs: z.record(z.string().regex(/^[A-Za-z0-9._-]+\.md$/), z.string().max(20000)).default({}),
  maxCorrections: z.number().int().min(0).max(5).default(3),
  workMode: z.enum(["serialized", "stacked"]).default("serialized"),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/**
 * Controlled projects are infrastructure (a repository with the gate, ruleset and machine-identity access, plus an isolated
 * Builder home), so they are registered by the operator configuration (AGENTS_PROJECTS), not created from the UI.
 */
export async function seedProjects(db: Db, raw = process.env.AGENTS_PROJECTS): Promise<number> {
  if (!raw) return 0;
  const list = z.array(ProjectConfig).parse(JSON.parse(raw));
  for (const p of list) {
    const [existing] = await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, p.slug));
    if (existing) await db.update(projects).set(p).where(eq(projects.id, existing.id));
    else await db.insert(projects).values(p);
  }
  return list.length;
}

/** Demonstration project of the gate preview (APP_ENV=preview only; no repository is ever contacted from a preview). */
export const PREVIEW_PROJECTS: ProjectConfig[] = [
  {
    slug: "demo",
    name: "Demo Project",
    description: "A demonstration project in the gate preview.",
    org: "preview-org",
    repo: "demo-repo",
    ownerLogin: "preview-owner",
    builderKey: "demo",
    stack: "Next.js 16, TypeScript, PostgreSQL",
    interfaceTasks: [],
    workerDocs: {},
    maxCorrections: 3,
    workMode: "serialized",
  },
];

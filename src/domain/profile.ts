/*
 * Project Capability Profile (Builder phase): what a managed project is and how it is built and checked - read from the project's
 * own files, never guessed and never asked of a worker. Consumers: the Context Builder, the Router, planning, and later the Gate.
 */
export interface CapabilityProfile {
  commit: string;
  languages: string[];
  framework: string | null;
  packageManager: string | null;
  commands: { build: string | null; test: string | null; lint: string | null; typecheck: string | null };
  /** the repository Dockerfile has a `check` stage (what the gate runs) */
  checkStage: boolean;
  browserTests: boolean;
  database: string | null;
  tooling: string[];
  /** what could not be established (never silently assumed) */
  unknown: string[];
}

type Files = Record<string, string | null | undefined>;

export function detectProfile(commit: string, files: Files, fileList: string[] = []): CapabilityProfile {
  const unknown: string[] = [];
  const has = (p: string) => typeof files[p] === "string" || fileList.includes(p);
  type Pkg = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; packageManager?: string };
  const parse = (): Pkg | null => {
    try {
      return files["package.json"] ? (JSON.parse(files["package.json"]) as Pkg) : null;
    } catch {
      unknown.push("package.json is not valid JSON");
      return null;
    }
  };
  const pkg = parse();
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const dep = (n: string) => n in deps;
  const languages: string[] = [];
  if (has("tsconfig.json") || dep("typescript")) languages.push("typescript");
  else if (pkg) languages.push("javascript");
  if (has("composer.json")) languages.push("php");
  if (has("pyproject.toml") || has("requirements.txt")) languages.push("python");
  if (has("go.mod")) languages.push("go");
  if (languages.length === 0) unknown.push("language");
  const framework = dep("next") ? "next" : dep("@remix-run/node") ? "remix" : dep("vite") ? "vite" : has("artisan") ? "laravel" : dep("express") ? "express" : null;
  const packageManager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") ? "bun" : has("package-lock.json") ? "npm" : pkg?.packageManager ? String(pkg.packageManager).split("@")[0]! : has("composer.lock") ? "composer" : pkg ? "npm" : null;
  const run = packageManager && ["npm", "pnpm", "yarn", "bun"].includes(packageManager) ? `${packageManager} run` : null;
  const script = (...names: string[]) => {
    const n = names.find((x) => pkg?.scripts?.[x]);
    return n && run ? `${run} ${n}` : null;
  };
  const commands = {
    build: script("build"),
    test: script("test", "test:unit"),
    lint: script("lint"),
    typecheck: script("typecheck", "type-check", "tsc") ?? (languages.includes("typescript") && packageManager ? "npx tsc --noEmit" : null),
  };
  for (const [k, v] of Object.entries(commands)) if (!v) unknown.push(`${k} command`);
  const docker = files["Dockerfile"] ?? "";
  const tooling = ["eslint", "prettier", "vitest", "jest", "playwright", "@playwright/test", "drizzle-kit", "tailwindcss"].filter(dep);
  return {
    commit,
    languages,
    framework,
    packageManager,
    commands,
    checkStage: /^FROM\s+.+\s+AS\s+check\b/im.test(docker),
    browserTests: dep("playwright") || dep("@playwright/test") || fileList.some((f) => /playwright\.config\.[cm]?[jt]s$/.test(f)),
    database: dep("drizzle-orm") || dep("pg") ? "postgresql" : dep("mysql2") ? "mysql" : dep("better-sqlite3") ? "sqlite" : null,
    tooling,
    unknown,
  };
}

/**
 * Server start hook. In the gate PREVIEW (APP_ENV=preview) the web server is the only process: it applies the migrations and seeds a
 * demonstration project so black-box checks can exercise the UI. In production the control loop (worker) owns migrations and the
 * operator configuration owns projects - nothing happens here.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.APP_ENV !== "preview") return;
  const { createDb } = await import("@/db/client");
  const { migrate } = await import("@/db/migrate");
  const { seedProjects, PREVIEW_PROJECTS } = await import("@/db/seed");
  const url = process.env.DATABASE_URL!;
  const db = await createDb(url);
  await migrate(db, url);
  await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
  const { seedPreviewDemo } = await import("@/db/preview-demo");
  await seedPreviewDemo(db);
}

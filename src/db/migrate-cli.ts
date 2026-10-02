import { createDb } from "./client";
import { migrate } from "./migrate";
import { seedProjects } from "./seed";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not configured");
const db = await createDb(url);
await migrate(db, url);
await seedProjects(db);
console.log(JSON.stringify({ migrated: true }));
process.exit(0);

-- Idempotent on purpose: an earlier form of this migration had already been applied to the live database before it was regenerated.
CREATE TABLE IF NOT EXISTS "admin_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"op" text NOT NULL,
	"task_id" integer,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"outcome" text NOT NULL,
	"refusal" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backups" (
	"id" serial PRIMARY KEY NOT NULL,
	"file" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'contract' NOT NULL;
--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "calibration" jsonb;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "work_mode" text DEFAULT 'serialized' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "budget_contract_id" integer;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "stack_parent_id" integer;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "paused_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "paused_reason" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_actions_task_idx" ON "admin_actions" USING btree ("task_id","id");

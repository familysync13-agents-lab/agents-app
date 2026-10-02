CREATE TABLE "admin_actions" (
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
CREATE TABLE "backups" (
	"id" serial PRIMARY KEY NOT NULL,
	"file" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "kind" text DEFAULT 'contract' NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "calibration" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "work_mode" text DEFAULT 'serialized' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "budget_contract_id" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "stack_parent_id" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "paused_reason" text;--> statement-breakpoint
CREATE INDEX "admin_actions_task_idx" ON "admin_actions" USING btree ("task_id","id");
CREATE TABLE "qualification_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"worker" text NOT NULL,
	"task_class" text NOT NULL,
	"mode" text NOT NULL,
	"task_id" integer,
	"input_sha256" text NOT NULL,
	"expected" text,
	"output" jsonb,
	"valid" boolean,
	"agree" boolean,
	"duration_ms" integer,
	"job_id" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "capability_profile" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "task_class" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "worker" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "harness" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "route_reason" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "envelope" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "plan_task" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "context_bytes" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "context_files" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "extra_files" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "failure_class" text;--> statement-breakpoint
ALTER TABLE "qualification_records" ADD CONSTRAINT "qualification_records_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "qualification_worker_class_idx" ON "qualification_records" USING btree ("worker","task_class");
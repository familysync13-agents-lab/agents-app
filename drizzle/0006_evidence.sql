CREATE TABLE "evidence_packages" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"scope" text NOT NULL,
	"plan_task" text,
	"head_sha" text NOT NULL,
	"contract_version" integer,
	"contract_sha256" text,
	"status" text NOT NULL,
	"summary" jsonb NOT NULL,
	"artifact_id" integer NOT NULL,
	"sha256" text NOT NULL,
	"stage" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "criterion_task" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "criterion_id" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "contract_version" integer;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "plan_task" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "collector" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "run_id" integer;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "gate_result_id" integer;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "check_name" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "seq" integer;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "prev_sha256" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "record_sha256" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "sealed" text;--> statement-breakpoint
ALTER TABLE "evidence_packages" ADD CONSTRAINT "evidence_packages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_packages_task_idx" ON "evidence_packages" USING btree ("task_id","head_sha");--> statement-breakpoint
CREATE INDEX "evidence_criterion_idx" ON "evidence" USING btree ("criterion_task","criterion_id");
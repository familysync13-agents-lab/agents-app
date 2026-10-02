CREATE TABLE "activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"actor" text NOT NULL,
	"message" text NOT NULL,
	"ref" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"sha256" text NOT NULL,
	"content" text NOT NULL,
	"worker_authored" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"text" text NOT NULL,
	"sha256" text NOT NULL,
	"lint" jsonb NOT NULL,
	"oracle_js" text,
	"oracle_sha256" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"owner_note" text,
	"pr_number" integer,
	"pr_head" text,
	"merge_commit" text,
	"github_approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"why" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommendation" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"choice" text,
	"note" text,
	"decided_via" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"subject" text NOT NULL,
	"status" text NOT NULL,
	"oracle" text NOT NULL,
	"persistence" text NOT NULL,
	"source" text NOT NULL,
	"commit_sha" text,
	"contract_sha256" text,
	"detail" text,
	"severity" text,
	"artifact_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executor_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer,
	"op" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gate_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"check_run_id" bigint NOT NULL,
	"verdict" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"contract_sha256" text,
	"kind" text NOT NULL,
	"evidence_artifact_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "heartbeats" (
	"name" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"info" jsonb
);
--> statement-breakpoint
CREATE TABLE "login_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "owner_sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"org" text NOT NULL,
	"repo" text NOT NULL,
	"owner_login" text NOT NULL,
	"builder_key" text NOT NULL,
	"stack" text NOT NULL,
	"interface_tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"worker_docs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_corrections" integer DEFAULT 3 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"role" text NOT NULL,
	"purpose" text NOT NULL,
	"container" text,
	"session_id" text,
	"status" text DEFAULT 'starting' NOT NULL,
	"outcome" text,
	"exit_code" text,
	"cost_usd" real,
	"turns" integer,
	"duration_ms" bigint,
	"closing_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"key" text,
	"title" text NOT NULL,
	"intent" text NOT NULL,
	"tier" text DEFAULT 'standard' NOT NULL,
	"state" text DEFAULT 'PROPOSED' NOT NULL,
	"state_reason" text,
	"resume_state" text,
	"step" text DEFAULT 'draft_contract' NOT NULL,
	"step_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_contract_id" integer,
	"branch" text,
	"pr_number" integer,
	"head_sha" text,
	"builder_session_id" text,
	"corrections" integer DEFAULT 0 NOT NULL,
	"extra_corrections" integer DEFAULT 0 NOT NULL,
	"infra_retries" integer DEFAULT 0 NOT NULL,
	"merge_commit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"reason" text NOT NULL,
	"fact" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executor_jobs" ADD CONSTRAINT "executor_jobs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_results" ADD CONSTRAINT "gate_results_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transitions" ADD CONSTRAINT "transitions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_task_idx" ON "activity" USING btree ("task_id","id");--> statement-breakpoint
CREATE INDEX "artifacts_task_idx" ON "artifacts" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_task_version_uq" ON "contracts" USING btree ("task_id","version");--> statement-breakpoint
CREATE INDEX "decisions_task_idx" ON "decisions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "decisions_status_idx" ON "decisions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "evidence_task_idx" ON "evidence" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "executor_jobs_status_idx" ON "executor_jobs" USING btree ("status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "gate_results_run_uq" ON "gate_results" USING btree ("check_run_id");--> statement-breakpoint
CREATE INDEX "gate_results_task_idx" ON "gate_results" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_uq" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "runs_task_idx" ON "runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_project_key_uq" ON "tasks" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "transitions_task_idx" ON "transitions" USING btree ("task_id");
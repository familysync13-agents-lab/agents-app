CREATE TABLE "qualification_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"worker" text NOT NULL,
	"task_class" text NOT NULL,
	"state" text DEFAULT 'start' NOT NULL,
	"record_ids" jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "qualification_records" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "qualification_records" ADD COLUMN "model_digest" text;--> statement-breakpoint
ALTER TABLE "qualification_records" ADD COLUMN "case_id" text;--> statement-breakpoint
ALTER TABLE "qualification_records" ADD COLUMN "case_set_sha256" text;--> statement-breakpoint
ALTER TABLE "qualification_records" ADD COLUMN "gate" boolean;--> statement-breakpoint
ALTER TABLE "qualification_records" ADD COLUMN "gate_detail" jsonb;--> statement-breakpoint
ALTER TABLE "qualification_records" ADD COLUMN "verifier" text;--> statement-breakpoint
ALTER TABLE "qualification_records" ADD COLUMN "verifier_note" text;--> statement-breakpoint
ALTER TABLE "qualification_records" ADD COLUMN "context_bytes" integer;--> statement-breakpoint
ALTER TABLE "qualification_records" ADD COLUMN "prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "qualification_records" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "qualification_records" ADD COLUMN "voided" boolean DEFAULT false NOT NULL;
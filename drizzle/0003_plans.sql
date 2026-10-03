CREATE TABLE "plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"contract_id" integer NOT NULL,
	"plan_version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"coverage" jsonb NOT NULL,
	"integrated" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_task_version_uq" ON "plans" USING btree ("task_id","plan_version");
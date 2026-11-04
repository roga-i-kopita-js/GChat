CREATE TABLE "gchat_auth_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotation_request_id" uuid,
	"rotation_token_hash" text,
	"rotation_encrypted" text,
	"rotation_expires_at" timestamp with time zone,
	"ws_ticket_window_started_at" timestamp with time zone,
	"ws_ticket_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "gchat_auth_sessions_rotation_check" CHECK (num_nonnulls("gchat_auth_sessions"."rotation_request_id", "gchat_auth_sessions"."rotation_token_hash", "gchat_auth_sessions"."rotation_encrypted", "gchat_auth_sessions"."rotation_expires_at") in (0, 4)),
	CONSTRAINT "gchat_auth_sessions_ticket_window_check" CHECK (("gchat_auth_sessions"."ws_ticket_window_started_at" is null and "gchat_auth_sessions"."ws_ticket_count" = 0) or ("gchat_auth_sessions"."ws_ticket_window_started_at" is not null and "gchat_auth_sessions"."ws_ticket_count" > 0))
);
--> statement-breakpoint
CREATE TABLE "gchat_auth_ws_tickets" (
	"ticket_hash" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gchat_auth_ws_tickets_expiry_check" CHECK ("gchat_auth_ws_tickets"."expires_at" > "gchat_auth_ws_tickets"."issued_at")
);
--> statement-breakpoint
ALTER TABLE "gchat_users" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "gchat_auth_sessions" ADD CONSTRAINT "gchat_auth_sessions_user_id_gchat_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."gchat_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_auth_ws_tickets" ADD CONSTRAINT "gchat_auth_ws_tickets_session_id_gchat_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."gchat_auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gchat_auth_sessions_user_id_idx" ON "gchat_auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "gchat_auth_sessions_rotation_expiry_idx" ON "gchat_auth_sessions" USING btree ("rotation_expires_at") WHERE "gchat_auth_sessions"."rotation_expires_at" is not null;--> statement-breakpoint
CREATE INDEX "gchat_auth_sessions_ticket_window_idx" ON "gchat_auth_sessions" USING btree ("ws_ticket_window_started_at") WHERE "gchat_auth_sessions"."ws_ticket_window_started_at" is not null;--> statement-breakpoint
CREATE INDEX "gchat_auth_ws_tickets_session_id_idx" ON "gchat_auth_ws_tickets" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "gchat_auth_ws_tickets_expiry_idx" ON "gchat_auth_ws_tickets" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "gchat_groups" ADD CONSTRAINT "gchat_groups_name_unique" UNIQUE("name");--> statement-breakpoint
ALTER TABLE "gchat_users" ADD CONSTRAINT "gchat_users_role_check" CHECK ("gchat_users"."role" in ('user', 'admin'));--> statement-breakpoint
ALTER TABLE "gchat_groups" ADD CONSTRAINT "gchat_groups_name_check" CHECK ("gchat_groups"."name" <> '' and "gchat_groups"."name" = lower(btrim("gchat_groups"."name")));
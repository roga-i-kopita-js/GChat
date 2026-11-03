CREATE TABLE "gchat_device_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gchat_device_session_pair" UNIQUE("device_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "gchat_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gchat_devices_owner" UNIQUE("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "gchat_device_voip_tokens" (
	"device_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"token" text NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gchat_device_voip_tokens_device_id_session_id_pk" PRIMARY KEY("device_id","session_id"),
	CONSTRAINT "gchat_voip_address" UNIQUE("environment","token"),
	CONSTRAINT "gchat_voip_environment" CHECK ("gchat_device_voip_tokens"."environment" in ('sandbox', 'production'))
);
--> statement-breakpoint
CREATE TABLE "gchat_direct_call_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version" bigint NOT NULL,
	"snapshot" jsonb,
	"device_id" uuid,
	"session_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "gchat_delivery_kind" CHECK ("gchat_direct_call_deliveries"."kind" in ('state','voip')),
	CONSTRAINT "gchat_delivery_status" CHECK ("gchat_direct_call_deliveries"."status" in ('pending','processing','done','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "gchat_direct_call_participants" (
	"call_id" uuid NOT NULL,
	"role" text NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"session_id" uuid,
	"connected_at" timestamp with time zone,
	"connected_negotiation_id" uuid,
	"last_sequence" bigint DEFAULT 0 NOT NULL,
	"last_ping_at" timestamp with time zone,
	"audio_connected" boolean DEFAULT false NOT NULL,
	"confirmed_recovery_id" uuid,
	"released_at" timestamp with time zone,
	CONSTRAINT "gchat_direct_call_participants_call_id_role_pk" PRIMARY KEY("call_id","role"),
	CONSTRAINT "gchat_call_participant_role" CHECK ("gchat_direct_call_participants"."role" in ('caller','recipient')),
	CONSTRAINT "gchat_call_participant_binding" CHECK (("gchat_direct_call_participants"."device_id" is null) = ("gchat_direct_call_participants"."session_id" is null)),
	CONSTRAINT "gchat_call_participant_sequence" CHECK ("gchat_direct_call_participants"."last_sequence" between 0 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "gchat_direct_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"caller_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"version" bigint DEFAULT 0 NOT NULL,
	"ringing_deadline" timestamp with time zone,
	"connecting_started_at" timestamp with time zone,
	"connecting_deadline" timestamp with time zone,
	"recovery_id" uuid,
	"recovery_started_at" timestamp with time zone,
	"recovery_deadline" timestamp with time zone,
	"negotiation_id" uuid,
	CONSTRAINT "gchat_calls_different_users" CHECK ("gchat_direct_calls"."caller_id" <> "gchat_direct_calls"."recipient_id"),
	CONSTRAINT "gchat_calls_state" CHECK ("gchat_direct_calls"."state" in ('ringing','connecting','active','ended')),
	CONSTRAINT "gchat_calls_version" CHECK ("gchat_direct_calls"."version" between 0 and 9007199254740991),
	CONSTRAINT "gchat_calls_ended" CHECK (("gchat_direct_calls"."state" = 'ended') = ("gchat_direct_calls"."ended_at" is not null and "gchat_direct_calls"."end_reason" is not null)),
	CONSTRAINT "gchat_calls_reason" CHECK ("gchat_direct_calls"."end_reason" is null or "gchat_direct_calls"."end_reason" in ('cancelled','rejected','no_answer','connection_timeout','hangup','connection_lost','session_revoked','account_disabled')),
	CONSTRAINT "gchat_calls_recovery" CHECK (("gchat_direct_calls"."recovery_id" is null) = ("gchat_direct_calls"."recovery_deadline" is null) and ("gchat_direct_calls"."recovery_id" is null or "gchat_direct_calls"."state" = 'active'))
);
--> statement-breakpoint
ALTER TABLE "gchat_device_sessions" ADD CONSTRAINT "gchat_device_sessions_user_id_gchat_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."gchat_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_device_sessions" ADD CONSTRAINT "gchat_device_sessions_device_id_user_id_gchat_devices_id_user_id_fk" FOREIGN KEY ("device_id","user_id") REFERENCES "public"."gchat_devices"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_devices" ADD CONSTRAINT "gchat_devices_user_id_gchat_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."gchat_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_device_voip_tokens" ADD CONSTRAINT "gchat_device_voip_tokens_device_id_session_id_gchat_device_sessions_device_id_session_id_fk" FOREIGN KEY ("device_id","session_id") REFERENCES "public"."gchat_device_sessions"("device_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_direct_call_deliveries" ADD CONSTRAINT "gchat_direct_call_deliveries_call_id_gchat_direct_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."gchat_direct_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_direct_call_participants" ADD CONSTRAINT "gchat_direct_call_participants_call_id_gchat_direct_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."gchat_direct_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_direct_call_participants" ADD CONSTRAINT "gchat_direct_call_participants_user_id_gchat_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."gchat_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_direct_call_participants" ADD CONSTRAINT "gchat_direct_call_participants_device_id_session_id_gchat_device_sessions_device_id_session_id_fk" FOREIGN KEY ("device_id","session_id") REFERENCES "public"."gchat_device_sessions"("device_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_direct_calls" ADD CONSTRAINT "gchat_direct_calls_caller_id_gchat_users_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."gchat_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_direct_calls" ADD CONSTRAINT "gchat_direct_calls_recipient_id_gchat_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."gchat_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gchat_delivery_state_version" ON "gchat_direct_call_deliveries" USING btree ("call_id","version") WHERE "gchat_direct_call_deliveries"."kind" = 'state';--> statement-breakpoint
CREATE UNIQUE INDEX "gchat_delivery_voip_target" ON "gchat_direct_call_deliveries" USING btree ("call_id","device_id","session_id") WHERE "gchat_direct_call_deliveries"."kind" = 'voip';--> statement-breakpoint
CREATE INDEX "gchat_delivery_pending" ON "gchat_direct_call_deliveries" USING btree ("next_attempt_at") WHERE "gchat_direct_call_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "gchat_delivery_processing" ON "gchat_direct_call_deliveries" USING btree ("lease_until") WHERE "gchat_direct_call_deliveries"."status" = 'processing';--> statement-breakpoint
CREATE UNIQUE INDEX "gchat_call_participant_busy" ON "gchat_direct_call_participants" USING btree ("user_id") WHERE "gchat_direct_call_participants"."released_at" is null;--> statement-breakpoint
CREATE INDEX "gchat_call_participant_session" ON "gchat_direct_call_participants" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "gchat_calls_caller" ON "gchat_direct_calls" USING btree ("caller_id","created_at");--> statement-breakpoint
CREATE INDEX "gchat_calls_recipient" ON "gchat_direct_calls" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "gchat_calls_ringing_deadline" ON "gchat_direct_calls" USING btree ("ringing_deadline") WHERE "gchat_direct_calls"."state" = 'ringing';--> statement-breakpoint
CREATE INDEX "gchat_calls_connecting_deadline" ON "gchat_direct_calls" USING btree ("connecting_deadline") WHERE "gchat_direct_calls"."state" = 'connecting';--> statement-breakpoint
CREATE INDEX "gchat_calls_recovery_deadline" ON "gchat_direct_calls" USING btree ("recovery_deadline") WHERE "gchat_direct_calls"."state" = 'active';
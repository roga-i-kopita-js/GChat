CREATE TABLE "gchat_device_apns_tokens" (
	"device_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"token" text NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gchat_device_apns_tokens_device_id_session_id_pk" PRIMARY KEY("device_id","session_id"),
	CONSTRAINT "gchat_apns_address" UNIQUE("environment","token"),
	CONSTRAINT "gchat_apns_environment" CHECK ("gchat_device_apns_tokens"."environment" in ('sandbox', 'production'))
);
--> statement-breakpoint
CREATE TABLE "gchat_dialog_encryption_keys" (
	"key_id" text PRIMARY KEY NOT NULL,
	"key_fingerprint" "bytea" NOT NULL,
	"encryption_attempts" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "gchat_dialog_encryption_keys_key_fingerprint_unique" UNIQUE("key_fingerprint"),
	CONSTRAINT "gchat_dialog_key_id" CHECK ("gchat_dialog_encryption_keys"."key_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "gchat_dialog_key_fingerprint" CHECK (octet_length("gchat_dialog_encryption_keys"."key_fingerprint") = 32),
	CONSTRAINT "gchat_dialog_key_attempts" CHECK ("gchat_dialog_encryption_keys"."encryption_attempts" between 0 and 16777216)
);
--> statement-breakpoint
CREATE TABLE "gchat_dialog_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dialog_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_device_id" uuid NOT NULL,
	"client_message_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"encryption_version" integer NOT NULL,
	"encryption_key_id" text NOT NULL,
	"iv" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	CONSTRAINT "gchat_dialog_message_sequence" UNIQUE("dialog_id","sequence"),
	CONSTRAINT "gchat_dialog_message_client" UNIQUE("dialog_id","sender_id","client_message_id"),
	CONSTRAINT "gchat_dialog_message_iv" UNIQUE("encryption_key_id","iv"),
	CONSTRAINT "gchat_dialog_message_sequence_range" CHECK ("gchat_dialog_messages"."sequence" between 1 and 9007199254740991),
	CONSTRAINT "gchat_dialog_message_version" CHECK ("gchat_dialog_messages"."encryption_version" = 1),
	CONSTRAINT "gchat_dialog_message_key" CHECK (length("gchat_dialog_messages"."encryption_key_id") > 0),
	CONSTRAINT "gchat_dialog_message_iv_size" CHECK (octet_length("gchat_dialog_messages"."iv") = 12),
	CONSTRAINT "gchat_dialog_message_cipher_size" CHECK (octet_length("gchat_dialog_messages"."ciphertext") > 0),
	CONSTRAINT "gchat_dialog_message_tag_size" CHECK (octet_length("gchat_dialog_messages"."auth_tag") = 16)
);
--> statement-breakpoint
CREATE TABLE "gchat_dialogs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_low_id" uuid NOT NULL,
	"participant_high_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"participant_low_last_read_sequence" bigint DEFAULT 0 NOT NULL,
	"participant_high_last_read_sequence" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "gchat_dialog_pair" UNIQUE("participant_low_id","participant_high_id"),
	CONSTRAINT "gchat_dialog_pair_order" CHECK ("gchat_dialogs"."participant_low_id" < "gchat_dialogs"."participant_high_id"),
	CONSTRAINT "gchat_dialog_sequence" CHECK ("gchat_dialogs"."last_sequence" between 0 and 9007199254740991),
	CONSTRAINT "gchat_dialog_empty" CHECK (("gchat_dialogs"."last_sequence" = 0 and "gchat_dialogs"."last_message_at" is null) or ("gchat_dialogs"."last_sequence" > 0 and "gchat_dialogs"."last_message_at" is not null)),
	CONSTRAINT "gchat_dialog_low_read" CHECK ("gchat_dialogs"."participant_low_last_read_sequence" between 0 and "gchat_dialogs"."last_sequence"),
	CONSTRAINT "gchat_dialog_high_read" CHECK ("gchat_dialogs"."participant_high_last_read_sequence" between 0 and "gchat_dialogs"."last_sequence")
);
--> statement-breakpoint
ALTER TABLE "gchat_device_apns_tokens" ADD CONSTRAINT "gchat_device_apns_tokens_device_id_session_id_gchat_device_sessions_device_id_session_id_fk" FOREIGN KEY ("device_id","session_id") REFERENCES "public"."gchat_device_sessions"("device_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_dialog_messages" ADD CONSTRAINT "gchat_dialog_messages_dialog_id_gchat_dialogs_id_fk" FOREIGN KEY ("dialog_id") REFERENCES "public"."gchat_dialogs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_dialog_messages" ADD CONSTRAINT "gchat_dialog_messages_sender_id_gchat_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."gchat_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_dialogs" ADD CONSTRAINT "gchat_dialogs_participant_low_id_gchat_users_id_fk" FOREIGN KEY ("participant_low_id") REFERENCES "public"."gchat_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_dialogs" ADD CONSTRAINT "gchat_dialogs_participant_high_id_gchat_users_id_fk" FOREIGN KEY ("participant_high_id") REFERENCES "public"."gchat_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gchat_dialog_low_activity" ON "gchat_dialogs" USING btree ("participant_low_id",coalesce("last_message_at", "created_at") desc,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gchat_dialog_high_activity" ON "gchat_dialogs" USING btree ("participant_high_id",coalesce("last_message_at", "created_at") desc,"id" DESC NULLS LAST);
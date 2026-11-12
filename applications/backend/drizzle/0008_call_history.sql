CREATE TABLE "gchat_direct_call_history" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"caller_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone NOT NULL,
	"end_reason" text NOT NULL,
	"version" bigint NOT NULL,
	CONSTRAINT "gchat_call_history_users" CHECK ("gchat_direct_call_history"."caller_id" <> "gchat_direct_call_history"."recipient_id"),
	CONSTRAINT "gchat_call_history_version" CHECK ("gchat_direct_call_history"."version" between 0 and 9007199254740991),
	CONSTRAINT "gchat_call_history_reason" CHECK ("gchat_direct_call_history"."end_reason" in ('cancelled','rejected','no_answer','connection_timeout','hangup','connection_lost','session_revoked','account_disabled')),
	CONSTRAINT "gchat_call_history_times" CHECK ("gchat_direct_call_history"."ended_at" >= "gchat_direct_call_history"."created_at" and ("gchat_direct_call_history"."started_at" is null or ("gchat_direct_call_history"."started_at" >= "gchat_direct_call_history"."created_at" and "gchat_direct_call_history"."started_at" <= "gchat_direct_call_history"."ended_at")))
);
--> statement-breakpoint
ALTER TABLE "gchat_direct_call_history" ADD CONSTRAINT "gchat_direct_call_history_caller_id_gchat_users_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."gchat_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_direct_call_history" ADD CONSTRAINT "gchat_direct_call_history_recipient_id_gchat_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."gchat_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gchat_call_history_caller" ON "gchat_direct_call_history" USING btree ("caller_id","created_at" DESC NULLS LAST,"call_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gchat_call_history_recipient" ON "gchat_direct_call_history" USING btree ("recipient_id","created_at" DESC NULLS LAST,"call_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gchat_call_history_missed" ON "gchat_direct_call_history" USING btree ("recipient_id","created_at" DESC NULLS LAST,"call_id" DESC NULLS LAST) WHERE "gchat_direct_call_history"."started_at" is null and "gchat_direct_call_history"."end_reason" in ('cancelled','no_answer');
--> statement-breakpoint
-- Copy retained terminal metadata before the old technical rows can be cleaned up.
INSERT INTO "gchat_direct_call_history"
  (call_id, caller_id, recipient_id, created_at, started_at, ended_at, end_reason, version)
SELECT id, caller_id, recipient_id, created_at, started_at, ended_at, end_reason, version
FROM "gchat_direct_calls" WHERE state = 'ended'
ON CONFLICT (call_id) DO NOTHING;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "gchat_direct_call_history" h JOIN "gchat_direct_calls" c ON c.id = h.call_id
    WHERE c.state = 'ended' AND
      (h.caller_id, h.recipient_id, h.created_at, h.started_at, h.ended_at, h.end_reason, h.version)
      IS DISTINCT FROM
      (c.caller_id, c.recipient_id, c.created_at, c.started_at, c.ended_at, c.end_reason, c.version)
  ) THEN
    RAISE EXCEPTION 'Call history backfill integrity failure';
  END IF;
END $$;

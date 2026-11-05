CREATE TABLE "gchat_device_web_push" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gchat_web_push_endpoint" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "gchat_direct_call_deliveries" DROP CONSTRAINT "gchat_delivery_kind";--> statement-breakpoint
ALTER TABLE "gchat_device_web_push" ADD CONSTRAINT "gchat_device_web_push_device_id_session_id_gchat_device_sessions_device_id_session_id_fk" FOREIGN KEY ("device_id","session_id") REFERENCES "public"."gchat_device_sessions"("device_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gchat_delivery_web_push_target" ON "gchat_direct_call_deliveries" USING btree ("call_id","device_id","session_id") WHERE "gchat_direct_call_deliveries"."kind" = 'web_push';--> statement-breakpoint
ALTER TABLE "gchat_direct_call_deliveries" ADD CONSTRAINT "gchat_delivery_kind" CHECK ("gchat_direct_call_deliveries"."kind" in ('state','voip','web_push'));
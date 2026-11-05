CREATE TABLE "gchat_native_websocket_restrictions" (
	"direction" text NOT NULL,
	"message_pattern" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gchat_native_websocket_restrictions_direction_message_pattern_pk" PRIMARY KEY("direction","message_pattern"),
	CONSTRAINT "gchat_native_ws_direction_check" CHECK ("gchat_native_websocket_restrictions"."direction" in ('send', 'receive')),
	CONSTRAINT "gchat_native_ws_pattern_check" CHECK ("gchat_native_websocket_restrictions"."message_pattern" ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)*([.][*])?$' and length("gchat_native_websocket_restrictions"."message_pattern") <= 128)
);

CREATE TABLE "gchat_group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "gchat_group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "gchat_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gchat_group_members" ADD CONSTRAINT "gchat_group_members_group_id_gchat_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."gchat_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gchat_group_members" ADD CONSTRAINT "gchat_group_members_user_id_gchat_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."gchat_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gchat_group_members_user_id_idx" ON "gchat_group_members" USING btree ("user_id");
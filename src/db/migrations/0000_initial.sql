CREATE TABLE `collection` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rel_path` text NOT NULL,
	`is_primary` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_rel_path_unique` ON `collection` (`rel_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_collection_one_primary` ON `collection` (`is_primary`) WHERE "collection"."is_primary" = 1;--> statement-breakpoint
CREATE TABLE `config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `file` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` integer NOT NULL,
	`rel_path` text NOT NULL,
	`size` integer NOT NULL,
	`mtime_ms` integer NOT NULL,
	`sha256_hex` text,
	`last_seen_run` integer,
	FOREIGN KEY (`collection_id`) REFERENCES `collection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_file_collection_relpath` ON `file` (`collection_id`,`rel_path`);--> statement-breakpoint
CREATE INDEX `idx_file_sha256` ON `file` (`sha256_hex`) WHERE "file"."sha256_hex" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_file_collection` ON `file` (`collection_id`);--> statement-breakpoint
CREATE INDEX `idx_file_relpath` ON `file` (`rel_path`);--> statement-breakpoint
CREATE TABLE `preset` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`cruft_rules_json` text NOT NULL,
	`whitelist_json` text NOT NULL,
	`path_priority_json` text NOT NULL,
	`is_builtin` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preset_name_unique` ON `preset` (`name`);--> statement-breakpoint
CREATE TABLE `quarantine_action` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`collection_id` integer NOT NULL,
	`src_rel_path` text NOT NULL,
	`dest_abs_path` text NOT NULL,
	`size` integer NOT NULL,
	`sha256_hex` text,
	`reason` text NOT NULL,
	`planned_at` text DEFAULT (datetime('now')) NOT NULL,
	`executed_at` text,
	`verified_at` text,
	`restored_at` text,
	`purged_at` text,
	`error` text,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`collection_id`) REFERENCES `collection`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_qa_run` ON `quarantine_action` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_qa_pending` ON `quarantine_action` (`executed_at`,`error`) WHERE "quarantine_action"."executed_at" IS NULL AND "quarantine_action"."error" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_qa_active` ON `quarantine_action` (`executed_at`,`restored_at`,`purged_at`);--> statement-breakpoint
CREATE TABLE `review_item` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`basename` text NOT NULL,
	`a_collection_id` integer NOT NULL,
	`a_rel_path` text NOT NULL,
	`a_sha256_hex` text NOT NULL,
	`a_size` integer NOT NULL,
	`b_collection_id` integer NOT NULL,
	`b_rel_path` text NOT NULL,
	`b_sha256_hex` text NOT NULL,
	`b_size` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`a_collection_id`) REFERENCES `collection`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`b_collection_id`) REFERENCES `collection`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_item_status" CHECK("review_item"."status" IN ('open','kept_both','quarantined_a','quarantined_b'))
);
--> statement-breakpoint
CREATE INDEX `idx_review_status` ON `review_item` (`status`);--> statement-breakpoint
CREATE TABLE `run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`dry_run` integer DEFAULT 1 NOT NULL,
	`config_json` text NOT NULL,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`finished_at` text,
	CONSTRAINT "run_kind" CHECK("run"."kind" IN ('scan','quarantine','purge','restore')),
	CONSTRAINT "run_status" CHECK("run"."status" IN ('running','completed','crashed','failed','aborted'))
);
--> statement-breakpoint
CREATE INDEX `idx_run_status` ON `run` (`status`);--> statement-breakpoint
CREATE TABLE `target` (
	`id` integer PRIMARY KEY NOT NULL,
	`target_id_uuid` text NOT NULL,
	`target_root_abs` text NOT NULL,
	`os_platform` text NOT NULL,
	`bound_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "target_id_singleton" CHECK("target"."id" = 1),
	CONSTRAINT "target_os_platform" CHECK("target"."os_platform" IN ('win32','linux','darwin'))
);

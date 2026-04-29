CREATE TABLE IF NOT EXISTS `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`emoji` text NOT NULL,
	`last_opened` integer NOT NULL,
	`color` text,
	`status` text,
	`daintree_config_present` integer,
	`in_repo_settings` integer,
	`pinned` integer DEFAULT 0 NOT NULL,
	`frecency_score` real DEFAULT 3 NOT NULL,
	`last_accessed_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`queued_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`dependencies` text DEFAULT '[]' NOT NULL,
	`worktree_id` text,
	`assigned_agent_id` text,
	`run_id` text,
	`metadata` text,
	`result` text,
	`routing_hints` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_project_idx` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_project_status_idx` ON `tasks` (`project_id`,`status`);

CREATE TABLE `remote_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_device_id` text,
	`session_id` text,
	`operation` text NOT NULL,
	`result` text NOT NULL,
	`target_project_id` text,
	`target_worktree_id` text,
	`target_panel_id` text,
	`character_count` integer,
	`byte_count` integer,
	`content_digest` text,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `remote_audit_occurred_idx` ON `remote_audit_events` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `remote_mutation_ledger` (
	`device_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`operation_type` text NOT NULL,
	`argument_digest` text NOT NULL,
	`outcome` text NOT NULL,
	`result_code` text,
	`created_resource_id` text,
	`created_at` integer NOT NULL,
	`committed_at` integer,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `idempotency_key`)
);
--> statement-breakpoint
CREATE INDEX `remote_mutation_expiry_created_idx` ON `remote_mutation_ledger` (`expires_at`,`created_at`);
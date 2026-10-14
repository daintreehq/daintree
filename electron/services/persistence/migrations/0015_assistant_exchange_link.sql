-- Enrollment generations are the policy's uuids. No build wrote to this table before this one, so it is recreated rather than copied.
DROP TABLE IF EXISTS `assistant_exchanges`;--> statement-breakpoint
CREATE TABLE `assistant_exchanges` (
	`task_id` text PRIMARY KEY NOT NULL,
	`sender_id` text NOT NULL,
	`message_id` text NOT NULL,
	`context_id` text NOT NULL,
	`reference_task_ids` text NOT NULL,
	`receiver_host_id` text NOT NULL,
	`receiver_lane_id` text NOT NULL,
	`enrollment_generation` text NOT NULL CHECK (length(`enrollment_generation`) BETWEEN 1 AND 256),
	`state` text NOT NULL CHECK (`state` IN ('submitted', 'working', 'input-required', 'completed', 'canceled', 'failed', 'rejected')),
	`outcome` text,
	`payload_digest` text NOT NULL,
	`body_digest` text NOT NULL,
	`body_bytes` integer NOT NULL CHECK (`body_bytes` >= 0),
	`reply_digest` text,
	`reply_bytes` integer CHECK (`reply_bytes` >= 0),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revision` integer NOT NULL,
	`delivery_attempted_at` integer,
	`accepted_at` integer,
	`wake_typed_at` integer,
	`inbox_fetched_at` integer,
	`reply_received_at` integer,
	`ambiguous_at` integer,
	`cancel_requested_at` integer,
	`terminal_at` integer,
	`tombstoned_at` integer,
	`purge_after` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_exchanges_sender_message_idx` ON `assistant_exchanges` (`sender_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `assistant_exchanges_sender_revision_idx` ON `assistant_exchanges` (`sender_id`,`revision`);--> statement-breakpoint
CREATE INDEX `assistant_exchanges_receiver_revision_idx` ON `assistant_exchanges` (`receiver_host_id`,`receiver_lane_id`,`enrollment_generation`,`revision`);--> statement-breakpoint
CREATE INDEX `assistant_exchanges_revision_idx` ON `assistant_exchanges` (`revision`);--> statement-breakpoint
CREATE INDEX `assistant_exchanges_expires_idx` ON `assistant_exchanges` (`expires_at`) WHERE `tombstoned_at` IS NULL;--> statement-breakpoint
CREATE INDEX `assistant_exchanges_purge_idx` ON `assistant_exchanges` (`purge_after`) WHERE `tombstoned_at` IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `assistant_exchange_hosts` (
	`host_id` text PRIMARY KEY NOT NULL,
	`sender_credential` text NOT NULL,
	`cursor` integer NOT NULL DEFAULT 0 CHECK (`cursor` >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `assistant_exchange_journal` (
	`host_id` text NOT NULL,
	`message_id` text NOT NULL,
	`sent_at` integer NOT NULL,
	`unresolved_at` integer,
	`record` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`host_id`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `assistant_exchange_journal_unresolved_idx` ON `assistant_exchange_journal` (`host_id`) WHERE `unresolved_at` IS NOT NULL;

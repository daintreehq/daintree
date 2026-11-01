-- The Decisions local store (#16002): the library's LocalStore rows, kept by electron/services/decisions/daintreeLocalStore.ts through raw SQL. The columns follow the library's own SQLite store at its current schema, without its legacy plaintext content column: question and answer content arrives sealed, and nothing here predates sealing. Turning Decisions off leaves these rows in place; only an explicit delete clears them.
CREATE TABLE IF NOT EXISTS `decisions_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `decisions_questions` (
	`question_id` text PRIMARY KEY NOT NULL,
	`alias` integer NOT NULL UNIQUE,
	`origin_host_id` text NOT NULL,
	`pane_id` text NOT NULL,
	`terminal_generation` integer NOT NULL,
	`ownership_principal` text NOT NULL,
	`agent_incarnation` text NOT NULL,
	`agent_kind` text NOT NULL,
	`agent_session_id` text,
	`project_id` text NOT NULL,
	`worktree_id` text NOT NULL,
	`worktree_root` text NOT NULL,
	`workflow_gate_id` text,
	`project_label` text,
	`machine_label` text,
	`requirement` text NOT NULL,
	`question_revision` integer NOT NULL DEFAULT 0,
	`remote_event_seq` integer,
	`origin_created_at` text NOT NULL,
	`expires_at` text,
	`local_status` text NOT NULL,
	`delivery_status` text NOT NULL,
	`last_injection_id` text,
	`last_attempt_at` text,
	`agent_resume_strategy` text,
	`error_code` text,
	`content_sealed` text,
	`answers_json` text NOT NULL DEFAULT '[]',
	`history_only` integer NOT NULL DEFAULT 0,
	`delivered_revision` integer NOT NULL DEFAULT 0,
	`attachment_digests` text NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `decisions_questions_pane_idx` ON `decisions_questions` (`origin_host_id`,`pane_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `decisions_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`question_id` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer NOT NULL DEFAULT 0,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `decisions_outbox_due_idx` ON `decisions_outbox` (`next_attempt_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `decisions_outbox_question_idx` ON `decisions_outbox` (`question_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `decisions_inbound_events` (
	`seq` integer PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL UNIQUE,
	`event_type` text NOT NULL,
	`json` text NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `decisions_inbound_events_unprocessed_idx` ON `decisions_inbound_events` (`seq`) WHERE `processed_at` IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `decisions_injection_intents` (
	`injection_id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`answer_revision` integer NOT NULL,
	`host_id` text NOT NULL,
	`pane_id` text NOT NULL,
	`terminal_generation` integer NOT NULL,
	`ownership_principal` text NOT NULL,
	`agent_incarnation` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `decisions_injection_intents_question_idx` ON `decisions_injection_intents` (`question_id`,`state`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `decisions_injection_intents_open_idx` ON `decisions_injection_intents` (`state`) WHERE `state` IN ('intent', 'typed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `decisions_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`json` text NOT NULL
);

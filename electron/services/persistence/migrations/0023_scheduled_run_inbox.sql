-- Scheduled runs that settled while no Daintree window was open (#15983), each waiting until a view has put it in the notification inbox. Written in the same transaction as the run's settlement. Cascades from the run, so a run that retention prunes or a deletion removes takes its wait with it.
CREATE TABLE IF NOT EXISTS `scheduled_run_inbox` (
	`run_id` text PRIMARY KEY NOT NULL REFERENCES `scheduled_runs`(`id`) ON DELETE CASCADE,
	`created_at` integer NOT NULL
);

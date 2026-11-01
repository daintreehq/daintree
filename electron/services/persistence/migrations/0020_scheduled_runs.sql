-- Scheduled-run history (#15976): one validated ScheduledRun per row as JSON, beside the columns its queries read. `live` is 1 while the run is open or a process of it was last seen running, which is what startup reconciliation and retention read. No foreign key to projects: ProjectStore deletes a project's runs itself, so no rewrite of a project row can cascade history away.
CREATE TABLE IF NOT EXISTS `scheduled_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`schedule_id` text NOT NULL,
	`occurrence_key` text,
	`terminal_id` text,
	`live` integer NOT NULL CHECK (`live` IN (0, 1)),
	`created_at` integer NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scheduled_runs_schedule_idx` ON `scheduled_runs` (`schedule_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scheduled_runs_project_idx` ON `scheduled_runs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `scheduled_runs_occurrence_idx` ON `scheduled_runs` (`schedule_id`,`occurrence_key`) WHERE `occurrence_key` IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scheduled_runs_terminal_idx` ON `scheduled_runs` (`terminal_id`) WHERE `terminal_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scheduled_runs_live_idx` ON `scheduled_runs` (`live`) WHERE `live` = 1;

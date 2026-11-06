-- The scheduler's evaluation point per schedule (#15979): the latest occurrence a run was registered for, launched, refused or skipped. Written in the same transaction as that run's row, so neither commits without the other, and kept when retention prunes the run, so an occurrence that old never runs again. Deleted with the schedule's or project's runs.
CREATE TABLE IF NOT EXISTS `schedule_evaluation_points` (
	`schedule_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`evaluated_through` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `schedule_evaluation_points_project_idx` ON `schedule_evaluation_points` (`project_id`);

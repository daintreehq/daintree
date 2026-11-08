-- The branch a schedule's next run owns in new-worktree mode (#16369): written before the worktree is created and consumed in the transaction that records the run, so a launch replayed after a crash, or retried by the scheduler, takes the same branch and git refuses a second worktree. At most one per schedule. Deleted with the schedule's or project's runs; the worktree itself is never deleted.
CREATE TABLE IF NOT EXISTS `scheduled_run_worktree_claims` (
	`schedule_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`from_remote` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scheduled_run_worktree_claims_project_idx` ON `scheduled_run_worktree_claims` (`project_id`);

-- Scheduled runs that settled while no Daintree window was open (#15983). `inbox_pending` is 1 from that settlement, written in the same transaction, until a view has put the run in the notification inbox. A pruned or deleted run takes its mark with it.
ALTER TABLE `scheduled_runs` ADD COLUMN `inbox_pending` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scheduled_runs_inbox_pending_idx` ON `scheduled_runs` (`inbox_pending`) WHERE `inbox_pending` = 1;

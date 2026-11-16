-- Indexes for the two reads that used to decode every row (#17075): Decisions questions by local status, and a schedule's live runs (every open run is live) newest first.
CREATE INDEX IF NOT EXISTS `decisions_questions_status_idx` ON `decisions_questions` (`local_status`,`alias`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scheduled_runs_schedule_live_idx` ON `scheduled_runs` (`schedule_id`,`created_at`) WHERE `live` = 1;

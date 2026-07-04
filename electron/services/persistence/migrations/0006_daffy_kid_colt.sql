CREATE INDEX IF NOT EXISTS `projects_path_idx` ON `projects` (`path`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `projects_frecency_last_opened_idx` ON `projects` (`frecency_score`,`last_opened`);

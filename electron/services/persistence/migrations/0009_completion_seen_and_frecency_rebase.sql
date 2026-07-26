ALTER TABLE `projects` ADD `last_completion_seen_at` integer;--> statement-breakpoint
UPDATE `projects` SET `last_accessed_at` = `last_opened` WHERE `last_accessed_at` <= 0;--> statement-breakpoint
UPDATE `projects` SET `frecency_score` = `frecency_score` * 0.3036062767938871 WHERE `frecency_score` > 0;

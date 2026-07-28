ALTER TABLE `projects` ADD `last_completion_seen_at` integer;--> statement-breakpoint
UPDATE `projects` SET `last_accessed_at` = `last_opened` WHERE `last_accessed_at` <= 0 OR `last_accessed_at` > `last_opened`;--> statement-breakpoint
UPDATE `projects` SET `frecency_score` = CASE WHEN `frecency_score` = 3.0 THEN 0.5 ELSE `frecency_score` * 0.3036062767938871 END WHERE `frecency_score` > 0;

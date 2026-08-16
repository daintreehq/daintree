ALTER TABLE `projects` ADD `resumable_agent_count` integer;--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `recently_closed_at`;--> statement-breakpoint
DELETE FROM `app_state` WHERE `key` = 'sessionOpenProjects';

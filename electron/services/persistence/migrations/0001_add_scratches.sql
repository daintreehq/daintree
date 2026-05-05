CREATE TABLE `scratches` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_opened` integer NOT NULL
);

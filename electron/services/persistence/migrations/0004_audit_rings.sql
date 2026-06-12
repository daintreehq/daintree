CREATE TABLE IF NOT EXISTS `audit_rings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ring` text NOT NULL,
	`record` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_rings_ring_idx` ON `audit_rings` (`ring`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_rings_ring_created_idx` ON `audit_rings` (`ring`,`created_at`);

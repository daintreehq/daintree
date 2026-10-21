-- Audit-ring flushes persist keyed deltas (#13596). Rows written before this stay NULL; each ring's first write of a session is a full replacement that keys them.
ALTER TABLE `audit_rings` ADD `record_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `audit_rings_ring_record_id_idx` ON `audit_rings` (`ring`,`record_id`);

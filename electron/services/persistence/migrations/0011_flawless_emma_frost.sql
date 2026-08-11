CREATE TABLE `remote_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`host_id` text NOT NULL,
	`display_name` text NOT NULL,
	`platform` text NOT NULL,
	`public_key` text NOT NULL,
	`capabilities` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	`revocation_reason` text
);
--> statement-breakpoint
CREATE INDEX `remote_devices_host_revoked_idx` ON `remote_devices` (`host_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `remote_host_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`host_id` text NOT NULL,
	`public_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`encrypted_private_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_host_identities_host_id_unique` ON `remote_host_identities` (`host_id`);

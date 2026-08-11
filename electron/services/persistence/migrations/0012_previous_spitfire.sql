CREATE TABLE `remote_tls_identities` (
	`host_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`certificate` text NOT NULL,
	`certificate_fingerprint` text NOT NULL,
	`encrypted_private_key` text NOT NULL,
	`created_at` integer NOT NULL
);

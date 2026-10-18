-- The Shell's sender credential per host moves out of the exchange journal (#13493): assistant control needs it, and the journal goes with the inbox. The store copies each existing credential across as it is, since a new one is a new sender to every host that knew the old.
CREATE TABLE IF NOT EXISTS `assistant_sender_credentials` (
	`host_id` text PRIMARY KEY NOT NULL,
	`sender_credential` text NOT NULL
);

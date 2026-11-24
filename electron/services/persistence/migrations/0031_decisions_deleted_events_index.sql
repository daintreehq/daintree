-- Index for the phone-image sweep's read of the relay's applied deletions (#17791): only processed decision.deleted events, so finding few or none never scans the whole inbound event history.
CREATE INDEX IF NOT EXISTS `decisions_inbound_events_deleted_idx` ON `decisions_inbound_events` (`seq`) WHERE `event_type` = 'decision.deleted' AND `processed_at` IS NOT NULL;

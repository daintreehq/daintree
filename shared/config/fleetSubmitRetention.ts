/**
 * How long a host keeps a fleet submit's outcome under its opId, so a resend
 * of that opId answers from the record instead of typing the prompt again.
 * Counted from when the submit settled on the host, which is never earlier
 * than the Shell's first send of it.
 */
export const FLEET_SUBMIT_RETENTION_MS = 10 * 60_000;

/**
 * How long after its first send a Shell may resend an unconfirmed submit under
 * the same opId and trust the host to answer from its record. Half the host's
 * retention, so a slow reconnect or a late settle can't outlast the record.
 * After this the outcome is unknown and a resend may type the prompt twice.
 */
export const FLEET_SAFE_RETRY_MS = FLEET_SUBMIT_RETENTION_MS / 2;

import { createHmac, randomBytes } from "node:crypto";

const QUESTION_ID = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Keyed per process: an id says nothing of the words it was made from, which
 * may hold a secret redaction missed, and none outlives the process that read
 * the screen.
 */
let key: Buffer | null = null;

/**
 * The id a paired device is sent for the question a run's screen asks, and
 * sends back with its answer. Made and checked only on the machine that reads
 * the screen, so a Shell relays it without reading it.
 */
export function questionIdOf(runId: string, spawnedAt: number, question: string): string {
  key ??= randomBytes(32);
  return createHmac("sha256", key)
    .update(JSON.stringify([runId, spawnedAt, question]))
    .digest("base64url")
    .slice(0, 32);
}

export function isQuestionId(value: unknown): value is string {
  return typeof value === "string" && QUESTION_ID.test(value);
}

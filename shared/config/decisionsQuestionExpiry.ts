const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long a question waits when its agent sets no expiry, unless the person
 * chose otherwise: the client library's own default (`DEFAULTS.questionExpiryMs`),
 * held equal to it by a test. Kept here because the setting's sanitiser runs on
 * main's startup path, where nothing of the libraries loads.
 */
export const DEFAULT_QUESTION_EXPIRY_MS = 7 * DAY_MS;

/**
 * The default expiries Settings offers (#16122), in ms, and null for none.
 * Every one is within what the library accepts (a test checks it), so a saved
 * choice can never make the policy refuse to start. The longest stays under
 * the relay's 366-day limit.
 */
export const QUESTION_EXPIRY_CHOICES: readonly (number | null)[] = [
  HOUR_MS,
  DAY_MS,
  3 * DAY_MS,
  DEFAULT_QUESTION_EXPIRY_MS,
  30 * DAY_MS,
  90 * DAY_MS,
  365 * DAY_MS,
  null,
];

/** Whether `value` is one of the expiries Settings offers. */
export function isQuestionExpiryChoice(value: unknown): value is number | null {
  return QUESTION_EXPIRY_CHOICES.includes(value as number | null);
}

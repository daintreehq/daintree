/**
 * Snooze ladder for a single agent run.
 *
 * Deliberately NOT the notification inbox's ladder (`snoozeTimestamps.ts`).
 * That one omits sub-hour slots on the reasoning that dev work happens in
 * deep-work blocks — true for an inbox thread, wrong for an agent. An agent
 * blocked on a question is a much shorter-lived thing than an inbox item, and
 * 15- and 30-minute defers are the common case. Two ladders that mean different
 * things are cheaper than one ladder bent to fit both.
 *
 * `unlimited` has no expiry at all. It is not "forever": every snooze is
 * cleared by typed input, so the ladder is a ceiling on how long the run can
 * stay quiet, not the mechanism that ends it. Most snoozes end because the user
 * came back and answered the agent.
 */
export type AgentSnoozeDurationOption = "15m" | "30m" | "6h" | "unlimited";

export const AGENT_SNOOZE_DURATION_OPTIONS: readonly AgentSnoozeDurationOption[] = [
  "15m",
  "30m",
  "6h",
  "unlimited",
] as const;

/**
 * Menu copy, sentence case and no trailing period per the microcopy rule.
 *
 * "Unlimited (until I interact)" names the release condition out loud because
 * it is the one option whose behaviour is not obvious from its own label — the
 * other three read as ceilings, and this one would otherwise read as "never".
 */
export const AGENT_SNOOZE_LABEL: Record<AgentSnoozeDurationOption, string> = {
  "15m": "15 minutes",
  "30m": "30 minutes",
  "6h": "6 hours",
  unlimited: "Unlimited (until I interact)",
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export function isAgentSnoozeDurationOption(value: unknown): value is AgentSnoozeDurationOption {
  return (
    typeof value === "string" &&
    (AGENT_SNOOZE_DURATION_OPTIONS as readonly string[]).includes(value)
  );
}

/**
 * Resolve an option to an absolute wake time (epoch ms), or undefined for
 * `unlimited`.
 *
 * Wall-clock by construction: the result is an absolute instant, so a machine
 * that sleeps for eight hours wakes up with a 30-minute snooze already over.
 * That is the contract — a snooze measured in "app uptime" would silently
 * extend itself across every sleep, which is the opposite of what a ceiling is
 * for.
 *
 * These are fixed offsets rather than wall-clock targets like the inbox's
 * "tomorrow 8am", so they need no DST correction: adding six hours to an
 * instant lands on the right instant regardless of what the local clock does in
 * between. `now` is injectable for tests.
 */
export function resolveAgentSnoozeDuration(
  option: AgentSnoozeDurationOption,
  now: number = Date.now()
): number | undefined {
  switch (option) {
    case "15m":
      return now + 15 * MINUTE_MS;
    case "30m":
      return now + 30 * MINUTE_MS;
    case "6h":
      return now + 6 * HOUR_MS;
    case "unlimited":
      return undefined;
  }
}

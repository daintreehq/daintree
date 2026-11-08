import { getAgentConfigFolderAccount } from "@shared/config/agentRegistry";
import {
  CLAUDE_USAGE_WINDOWS,
  CODEX_QUOTA_STALE_AFTER_MS,
  type ClaudeUsageAccount,
  type ClaudeUsageReading,
  type CodexQuotaProfile,
  type CodexQuotaWindow,
} from "@shared/types/ipc/agentQuota";
import { formatTimeAgo } from "./timeAgo";
import { windowLabel } from "./codexQuotaFormat";

/**
 * Which login a choice stands for. A saved account is matched by id; the
 * default login is the one a launch with no account lands on, unless the
 * preset it runs with names a folder of its own (#16407).
 */
export type AccountHeadroomTarget =
  | { kind: "account"; accountId: string }
  | { kind: "default"; presetNamesFolder?: boolean };

export interface AccountHeadroom {
  /** One line for a choice's row: the tightest known window and its reset. */
  text: string;
  /** The reading is old, or its window has since reset. Already spoken in `text`. */
  stale: boolean;
}

export interface AccountHeadroomSources {
  codex: readonly CodexQuotaProfile[] | null;
  claude: readonly ClaudeUsageAccount[] | null;
}

/** What Claude Code printed for a limit: "weekly limit" in sentence case for a row. */
export function claudeWindowLabel(window: ClaudeUsageReading["window"]): string {
  return window.charAt(0).toUpperCase() + window.slice(1);
}

/**
 * Whether launching a preset puts the agent's account folder somewhere of its
 * own. An explicit switch to the default login keeps that env (#16407), so the
 * base default's reading would describe a different folder.
 */
export function presetNamesAccountFolder(
  agentId: string,
  preset: { env?: Record<string, string> } | null | undefined
): boolean {
  const declaration = getAgentConfigFolderAccount(agentId);
  if (!declaration || !preset?.env) return false;
  const upper = declaration.envVar.toUpperCase();
  return Object.keys(preset.env).some((name) => name.toUpperCase() === upper);
}

const timeFormat: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** "14:05", "Tue 14:05" within the week, "Nov 10, 14:05" beyond it. */
function formatResetClock(resetsAt: number, now: number): string {
  const date = new Date(resetsAt);
  const time = date.toLocaleTimeString(undefined, timeFormat);
  if (date.toDateString() === new Date(now).toDateString()) return time;
  const day =
    Math.abs(resetsAt - now) < WEEK_MS
      ? date.toLocaleDateString(undefined, { weekday: "short" })
      : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} ${time}`;
}

function resetClause(resetsAt: number | null, now: number): string | undefined {
  if (resetsAt === null) return undefined;
  return `${resetsAt <= now ? "reset" : "resets"} ${formatResetClock(resetsAt, now)}`;
}

function join(parts: ReadonlyArray<string | undefined>, stale: boolean): string {
  const text = parts.filter((part): part is string => Boolean(part)).join(" · ");
  return stale ? `Stale · ${text}` : text;
}

function hasReset(window: { resetsAt: number | null }, now: number): boolean {
  return window.resetsAt !== null && window.resetsAt <= now;
}

/**
 * Windows whose reset hasn't passed describe the limit now; ones that have
 * describe a window that's over. The first kind wins whenever there is one.
 */
function liveOrAll<T extends { resetsAt: number | null }>(windows: readonly T[], now: number): T[] {
  const live = windows.filter((window) => !hasReset(window, now));
  return live.length > 0 ? live : [...windows];
}

function codexHeadroom(profile: CodexQuotaProfile, now: number): AccountHeadroom | undefined {
  if (profile.result.status !== "ok") return undefined;
  const { windows, fetchedAt } = profile.result;
  const candidates: readonly CodexQuotaWindow[] = liveOrAll(windows, now);
  // Highest use first; the shorter window on a tie, since it resets sooner.
  const tightest = candidates.reduce<CodexQuotaWindow | undefined>((worst, window) => {
    if (!worst) return window;
    if (window.usedPercent !== worst.usedPercent) {
      return window.usedPercent > worst.usedPercent ? window : worst;
    }
    return window.windowDurationMins < worst.windowDurationMins ? window : worst;
  }, undefined);
  if (!tightest) return undefined;
  const stale = now - fetchedAt > CODEX_QUOTA_STALE_AFTER_MS || hasReset(tightest, now);
  return {
    text: join(
      [
        `${windowLabel(tightest.windowDurationMins)} ${Math.round(tightest.usedPercent)}% used`,
        resetClause(tightest.resetsAt, now),
      ],
      stale
    ),
    stale,
  };
}

const CLAUDE_WINDOW_ORDER = new Map<string, number>(
  CLAUDE_USAGE_WINDOWS.map((window, index) => [window, index])
);

/**
 * How firmly a reading says the limit is near. A hit limit outranks any
 * figure, a figure outranks a message that gave none, and no percent is made
 * up for "approaching": two messages that can't be compared stay unranked
 * against each other and the newer one stands.
 */
function claudeSeverity(reading: ClaudeUsageReading): [tier: number, percent: number, over: number] {
  if (reading.statement === "reached") return [3, 0, 0];
  if (
    (reading.statement === "used" || reading.statement === "over") &&
    reading.usedPercent !== null
  ) {
    return [2, reading.usedPercent, reading.statement === "over" ? 1 : 0];
  }
  return [1, 0, 0];
}

function tighterClaude(a: ClaudeUsageReading, b: ClaudeUsageReading): ClaudeUsageReading {
  const left = claudeSeverity(a);
  const right = claudeSeverity(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i]! > right[i]! ? a : b;
  }
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt ? a : b;
  return (CLAUDE_WINDOW_ORDER.get(a.window) ?? 0) <= (CLAUDE_WINDOW_ORDER.get(b.window) ?? 0)
    ? a
    : b;
}

function claudeStatementClause(reading: ClaudeUsageReading): string {
  const limit = claudeWindowLabel(reading.window);
  const percent = reading.usedPercent === null ? null : Math.round(reading.usedPercent);
  if (reading.statement === "reached") return `${limit} reached`;
  if (reading.statement === "used" && percent !== null) return `${limit} ${percent}% used`;
  if (reading.statement === "over" && percent !== null) return `${limit} over ${percent}% used`;
  return `Approaching ${reading.window}`;
}

function claudeHeadroom(account: ClaudeUsageAccount, now: number): AccountHeadroom | undefined {
  const tightest = liveOrAll(account.readings, now).reduce<ClaudeUsageReading | undefined>(
    (worst, reading) => (worst ? tighterClaude(worst, reading) : reading),
    undefined
  );
  if (!tightest) return undefined;
  // A reading is a message a pane showed, so its age is part of what it says.
  const stale = hasReset(tightest, now);
  return {
    text: join(
      [
        claudeStatementClause(tightest),
        resetClause(tightest.resetsAt, now),
        `observed ${formatTimeAgo(tightest.observedAt, now)}`,
      ],
      stale
    ),
    stale,
  };
}

/** The only one, or nothing: a choice never borrows the reading of a login it might not be. */
function onlyMatch<T>(candidates: readonly T[]): T | undefined {
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * The tightest known window for one account choice, from what main already
 * reads: Codex's own quota for the account's folder, and for Claude Code only
 * what a pane showed (#16370). Nothing when there is no reading to give.
 */
export function accountHeadroom(
  agentId: string | undefined,
  target: AccountHeadroomTarget,
  sources: AccountHeadroomSources,
  now: number
): AccountHeadroom | undefined {
  if (agentId === "codex" && sources.codex) {
    const profile =
      target.kind === "account"
        ? onlyMatch(sources.codex.filter((p) => p.accountIds?.includes(target.accountId)))
        : target.presetNamesFolder
          ? undefined
          : onlyMatch(sources.codex.filter((p) => p.isDefault));
    return profile && codexHeadroom(profile, now);
  }
  if (agentId === "claude" && sources.claude) {
    const account =
      target.kind === "account"
        ? onlyMatch(sources.claude.filter((a) => a.accountIds?.includes(target.accountId)))
        : target.presetNamesFolder
          ? undefined
          : onlyMatch(sources.claude.filter((a) => a.kind === "default"));
    return account && claudeHeadroom(account, now);
  }
  return undefined;
}

import type { ErrorRecord } from "@/store/errorStore";

/**
 * Fixtures for the error banner harness. Copy is lifted from the real
 * classifiers (`electron/utils/errorClassification.ts`,
 * `shared/utils/gitOperationErrors.ts`) so the banner is judged against what
 * it actually has to say, not a tidy placeholder.
 */

const NOW = 1_758_600_000_000;

function record(id: string, fields: Partial<ErrorRecord> & Pick<ErrorRecord, "message">) {
  return {
    id,
    timestamp: NOW,
    type: "unknown",
    retryability: "none",
    dismissed: false,
    ...fields,
  } satisfies ErrorRecord;
}

const FETCH_OFFLINE = record("fetch-offline", {
  type: "git",
  source: "git fetch",
  message: "git fetch failed: Could not resolve host: github.com",
  recoveryHint: "Check your internet connection and DNS settings.",
});

const NETWORK_RETRY = record("network-retry", {
  type: "network",
  source: "Pull request poller",
  message: "Request to api.github.com timed out after 30s",
  retryability: "auto",
  retryAction: "git",
  recoveryHint: "Check your network connection and try again.",
});

const NETWORK_RETRYING = record("network-retrying", {
  ...NETWORK_RETRY,
  id: "network-retrying",
  retryProgress: { attempt: 2, maxAttempts: 3 },
});

const PUSH_REJECTED = record("push-rejected", {
  type: "git",
  source: "git push",
  message: "Push rejected: the remote branch has commits you don't have locally",
  retryability: "user-gated",
  recoveryAction: { label: "Pull and rebase", actionId: "git.pullRebase" },
});

const PERMISSION = record("permission", {
  type: "filesystem",
  source: "File watcher",
  message: "EACCES: permission denied, open '/Users/greg/Projects/daintree/.git/index.lock'",
  recoveryHint: "Check file permissions or run with elevated privileges.",
});

const SPAWN_LONG = record("spawn-long", {
  type: "process",
  source: "Dev server",
  message:
    "npm run dev exited with code 1: Error: Cannot find module '/Users/greg/Projects/daintree/node_modules/vite/bin/vite.js' imported from the workspace root",
  recoveryHint: "Verify the file path is correct and the file exists.",
});

const CONFIG = record("config", {
  type: "config",
  source: ".daintree/project.json",
  message: "Unexpected token } in JSON at position 214",
});

export interface ErrorBannerScene {
  name: string;
  what: string;
  host: "terminal" | "card";
  width: number;
  maxInline: number;
  errors: ErrorRecord[];
  /** Wire `onRetry`; without it an auto-retryable error falls back to View errors, as in a host that never passes it. */
  retry?: boolean;
}

export const ERROR_BANNER_SCENES: ErrorBannerScene[] = [
  {
    name: "terminal-view-errors",
    what: "one error, no recovery wired — View errors",
    host: "terminal",
    width: 560,
    maxInline: 2,
    errors: [FETCH_OFFLINE],
  },
  {
    name: "terminal-retry",
    what: "auto-retryable error — Retry",
    host: "terminal",
    width: 560,
    maxInline: 2,
    errors: [NETWORK_RETRY],
    retry: true,
  },
  {
    name: "terminal-retrying",
    what: "retry in flight — progress + Cancel",
    host: "terminal",
    width: 560,
    maxInline: 2,
    errors: [NETWORK_RETRYING],
    retry: true,
  },
  {
    name: "terminal-recovery",
    what: "structured recovery action",
    host: "terminal",
    width: 560,
    maxInline: 2,
    errors: [PUSH_REJECTED],
  },
  {
    name: "terminal-overflow",
    what: "five errors, two inline, the rest behind the disclosure",
    host: "terminal",
    width: 560,
    maxInline: 2,
    errors: [FETCH_OFFLINE, PUSH_REJECTED, NETWORK_RETRY, PERMISSION, CONFIG],
    retry: true,
  },
  {
    name: "terminal-narrow",
    what: "long message and hint in a narrow pane",
    host: "terminal",
    width: 360,
    maxInline: 2,
    errors: [SPAWN_LONG, PERMISSION],
  },
  {
    name: "card-stack",
    what: "worktree card: four errors, two inline",
    host: "card",
    width: 320,
    maxInline: 2,
    errors: [PUSH_REJECTED, FETCH_OFFLINE, SPAWN_LONG, CONFIG],
  },
  {
    name: "card-single",
    what: "worktree card: one recoverable error",
    host: "card",
    width: 320,
    maxInline: 2,
    errors: [PUSH_REJECTED],
  },
];

export function requireErrorBannerScene(name: string): ErrorBannerScene {
  const scene = ERROR_BANNER_SCENES.find((s) => s.name === name);
  if (!scene) throw new Error(`unknown error banner scene "${name}"`);
  return scene;
}

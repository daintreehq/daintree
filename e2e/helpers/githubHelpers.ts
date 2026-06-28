import type { ElectronApplication, Page } from "@playwright/test";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../shared/utils/forgeProviderIds";
import type { Issue, Page as ForgePage } from "../../shared/types/forge";
import { activateE2EPlugin } from "./plugins";

/**
 * GitHub E2E helpers. All state is injected through the same fault-mode hooks
 * the app already exposes under `DAINTREE_E2E_FAULT_MODE=1` — no real GitHub
 * API call is ever made:
 *
 * - `__daintreeSeedGitHubToken` / `__daintreeClearGitHubToken` (main process,
 *   `plugins/builtin/github/main/index.ts`) seed an in-memory token, skipping
 *   validation by pre-populating cached user info.
 * - `window.__DAINTREE_E2E_REFRESH_GITHUB_CONFIG__` (renderer,
 *   `plugins/builtin/github/renderer/index.tsx`) re-hydrates the renderer's
 *   GitHub config store so `hasToken: true` lands.
 * - `forge:rate-limit-changed` / `forge:token-health-changed` pushes mirror
 *   the real `broadcastToRenderer` transport so the rate-limit and token-health
 *   surfaces light up exactly as in production.
 */

/** A throwaway token shaped like a classic PAT. Never validated against GitHub. */
export const E2E_GITHUB_TOKEN = "ghp_e2e_fake_token_0000000000000000000000";

/** Seed an in-memory GitHub token in the main process (no network validation). */
export async function seedGitHubToken(
  app: ElectronApplication,
  token: string = E2E_GITHUB_TOKEN
): Promise<void> {
  await activateE2EPlugin(app, "daintree.github");
  await app.evaluate((_modules, t) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- E2E hook
    const seed = (globalThis as any).__daintreeSeedGitHubToken as
      | ((token: string) => void)
      | undefined;
    if (!seed)
      throw new Error(
        "GitHub token seed hook not available — launch with DAINTREE_E2E_FAULT_MODE=1"
      );
    seed(t);
  }, token);
}

/** Clear the seeded in-memory GitHub token. */
export async function clearGitHubToken(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- E2E hook
    const clear = (globalThis as any).__daintreeClearGitHubToken as (() => void) | undefined;
    if (clear) clear();
  });
}

/** Refresh the renderer's GitHub config store so it picks up `hasToken: true`. */
export async function refreshGitHubConfig(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const refresh = window.__DAINTREE_E2E_REFRESH_GITHUB_CONFIG__;
    if (!refresh) throw new Error("E2E GitHub config refresh hook not available");
    await refresh();
  });
}

/**
 * Seed a token and hydrate the renderer config so every GitHub surface treats
 * the session as connected (toolbar pills, dropdowns, settings "connected").
 */
export async function connectGitHub(
  app: ElectronApplication,
  window: Page,
  token: string = E2E_GITHUB_TOKEN
): Promise<void> {
  await seedGitHubToken(app, token);
  await refreshGitHubConfig(window);
}

/** Broadcast a push event to every renderer webContents (mirrors broadcastToRenderer). */
async function broadcastToRenderers(
  app: ElectronApplication,
  channel: string,
  payload: unknown
): Promise<void> {
  await app.evaluate(
    ({ webContents }, { channel, payload }) => {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) {
          try {
            wc.send(channel, payload);
          } catch {
            // Ignore sends to a view mid-teardown.
          }
        }
      }
    },
    { channel, payload }
  );
}

/**
 * Push a primary rate-limit block for the built-in GitHub provider. `remaining: 0`
 * is what `toGitHubRateLimitPayload` reads to flip the renderer store to blocked.
 */
export async function pushRateLimitBlocked(
  app: ElectronApplication,
  resetInMs = 30_000
): Promise<void> {
  await broadcastToRenderers(app, "forge:rate-limit-changed", {
    providerId: BUILTIN_GITHUB_PROVIDER_ID,
    state: { limit: 5000, remaining: 0, resetAt: Date.now() + resetInMs },
  });
}

/** Clear the rate-limit block (full budget, unblocked). */
export async function pushRateLimitClear(app: ElectronApplication): Promise<void> {
  await broadcastToRenderers(app, "forge:rate-limit-changed", {
    providerId: BUILTIN_GITHUB_PROVIDER_ID,
    state: { limit: 5000, remaining: 5000, resetAt: null },
  });
}

/** Push an "unhealthy" token-health state (mirrors an authoritative 401 from GitHub). */
export async function pushTokenHealthUnhealthy(app: ElectronApplication): Promise<void> {
  await broadcastToRenderers(app, "forge:token-health-changed", {
    providerId: BUILTIN_GITHUB_PROVIDER_ID,
    isUnhealthy: true,
    state: { status: "unhealthy", tokenVersion: 1, checkedAt: Date.now() },
  });
}

/** Push a "healthy" token-health state to clear the banner. */
export async function pushTokenHealthHealthy(app: ElectronApplication): Promise<void> {
  await broadcastToRenderers(app, "forge:token-health-changed", {
    providerId: BUILTIN_GITHUB_PROVIDER_ID,
    isUnhealthy: false,
    state: { status: "healthy", tokenVersion: 1, checkedAt: Date.now() },
  });
}

/**
 * Replace the `forge:get-repo-stats` IPC handler with one returning fixture
 * counts. The real stats fetch hits the provider's network path, which with
 * the fake E2E token is a live 401 on networked runners and a network failure
 * offline — so `isTokenError`, the freshness level, and the pill's click
 * routing (#10347) would otherwise be nondeterministic, AND the polling loop
 * would keep clobbering any one-shot pushed counts with a "couldn't refresh"
 * error. Stubbing the handler makes every poll return the same fixed snapshot.
 * Pass `error` to force a failure state — token-pattern messages flip the pill
 * into its route-to-settings mode. Stash/restore mirrors {@link stubListIssues}.
 */
export async function stubRepoStats(
  app: ElectronApplication,
  stats: {
    issueCount: number | null;
    prCount: number | null;
    commitCount?: number;
    error?: string;
  },
  window?: Page
): Promise<void> {
  const now = Date.now();
  const response = {
    commitCount: stats.commitCount ?? 1,
    issueCount: stats.issueCount,
    prCount: stats.prCount,
    loading: false,
    error: stats.error,
    lastUpdated: now,
    issueCountRefreshedAt: now,
    prCountRefreshedAt: now,
  };
  await app.evaluate(
    ({ ipcMain }, { channel, response }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private Electron API
      const handlers = (ipcMain as any)._invokeHandlers as Map<string, unknown> | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stash for restore
      if (handlers && handlers.has(channel) && !(globalThis as any).__e2eOrigRepoStatsHandler) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stash for restore
        (globalThis as any).__e2eOrigRepoStatsHandler = handlers.get(channel);
      }
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async () => response);
    },
    { channel: "forge:get-repo-stats", response }
  );
  // Replacing the handler only fixes FUTURE polls; the stats hook keeps any
  // error state from a fetch that already landed until the next poll (a long
  // interval). When a `window` is supplied, also push the counts straight onto
  // the hook via the `forge:repo-counts-updated` broadcast so the pill updates
  // immediately — needed by tests that assert on pill state right away rather
  // than waiting out a re-poll.
  if (window) {
    const project = (await window.evaluate(() => window.electron.project.getCurrent())) as {
      path: string;
    } | null;
    if (project) {
      await broadcastToRenderers(app, "forge:repo-counts-updated", {
        providerId: BUILTIN_GITHUB_PROVIDER_ID,
        projectPath: project.path,
        stats: response,
        fetchedAt: now,
      });
    }
    // Force the stats hook through its normal successful-fetch path as well.
    // The count push can be ignored by the hook's freshness guard if a previous
    // token-error snapshot had an equal-or-newer timestamp, but the refresh
    // event re-reads the stubbed handler and clears `isTokenError`.
    await window.evaluate(() => {
      window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
    });
  }
}

/** Restore the real `forge:get-repo-stats` handler captured by {@link stubRepoStats}. */
export async function restoreRepoStats(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, channel) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private Electron API
    const handlers = (ipcMain as any)._invokeHandlers as Map<string, unknown> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore stashed handler
    const orig = (globalThis as any).__e2eOrigRepoStatsHandler;
    if (!orig) return;
    ipcMain.removeHandler(channel);
    if (handlers) handlers.set(channel, orig);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cleanup stash
    delete (globalThis as any).__e2eOrigRepoStatsHandler;
  }, "forge:get-repo-stats");
}

/** Build a minimal fixture issue (forge shape) for list stubbing. */
export function makeFixtureIssue(number: number, title: string): Issue {
  const updatedAt = Date.now() - number * 60_000;
  return {
    number,
    title,
    body: "",
    state: "open",
    rawState: "OPEN",
    url: `https://github.com/daintreehq/daintree/issues/${number}`,
    author: { login: "e2e-user", avatarUrl: "" },
    assignees: [],
    labels: [],
    commentCount: 0,
    createdAt: updatedAt,
    updatedAt,
    rawData: {},
  };
}

/**
 * Replace the `forge:list-issues` IPC handler with one returning fixture data.
 * The fault registry only models error/delay, so the bulk-selection flow — which
 * needs a populated list — overrides the handler directly. The original handler
 * is stashed on `globalThis` and restored by {@link restoreListIssues}.
 */
export async function stubListIssues(app: ElectronApplication, issues: Issue[]): Promise<void> {
  const response: ForgePage<Issue> = {
    items: issues,
    nextCursor: null,
    hasMore: false,
    totalCount: issues.length,
  };
  await app.evaluate(
    ({ ipcMain }, { channel, response }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private Electron API
      const handlers = (ipcMain as any)._invokeHandlers as Map<string, unknown> | undefined;
      // Only stash on the FIRST stub — a double-stub (without an intervening
      // restore) must not overwrite the real handler reference with a stub.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stash for restore
      if (handlers && handlers.has(channel) && !(globalThis as any).__e2eOrigListIssuesHandler) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stash for restore
        (globalThis as any).__e2eOrigListIssuesHandler = handlers.get(channel);
      }
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async () => response);
    },
    { channel: "forge:list-issues", response }
  );
}

/**
 * Restore the real `forge:list-issues` handler captured by {@link stubListIssues}.
 * No-op when nothing was stubbed, so it is safe to call unconditionally in
 * `afterEach` cleanup without orphaning the channel.
 */
export async function restoreListIssues(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, channel) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private Electron API
    const handlers = (ipcMain as any)._invokeHandlers as Map<string, unknown> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore stashed handler
    const orig = (globalThis as any).__e2eOrigListIssuesHandler;
    if (!orig) return; // nothing was stubbed — leave the real handler intact
    ipcMain.removeHandler(channel);
    if (handlers) handlers.set(channel, orig);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cleanup stash
    delete (globalThis as any).__e2eOrigListIssuesHandler;
  }, "forge:list-issues");
}

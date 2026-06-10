import type { ElectronApplication, Page } from "@playwright/test";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../shared/utils/forgeProviderIds";
import type { GitHubIssue, GitHubListResponse } from "../../shared/types/github";

/**
 * GitHub E2E helpers. All state is injected through the same fault-mode hooks
 * the app already exposes under `DAINTREE_E2E_FAULT_MODE=1` — no real GitHub
 * API call is ever made:
 *
 * - `__daintreeSeedGitHubToken` / `__daintreeClearGitHubToken` (main process,
 *   `electron/window/globalServicesInit.ts`) seed an in-memory token, skipping
 *   validation by pre-populating cached user info.
 * - `window.__DAINTREE_E2E_REFRESH_GITHUB_CONFIG__` (renderer,
 *   `plugins/builtin/github/renderer/index.tsx`) re-hydrates the renderer's
 *   GitHub config store so `hasToken: true` lands.
 * - `forge:rate-limit-changed` / `github:token-health-changed` pushes mirror
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
  await broadcastToRenderers(app, "github:token-health-changed", {
    status: "unhealthy",
    tokenVersion: 1,
    checkedAt: Date.now(),
  });
}

/** Push a "healthy" token-health state to clear the banner. */
export async function pushTokenHealthHealthy(app: ElectronApplication): Promise<void> {
  await broadcastToRenderers(app, "github:token-health-changed", {
    status: "healthy",
    tokenVersion: 1,
    checkedAt: Date.now(),
  });
}

/** Build a minimal fixture issue for list stubbing. */
export function makeFixtureIssue(number: number, title: string): GitHubIssue {
  return {
    number,
    title,
    url: `https://github.com/daintreehq/daintree/issues/${number}`,
    state: "OPEN",
    updatedAt: new Date(Date.now() - number * 60_000).toISOString(),
    author: { login: "e2e-user", avatarUrl: "" },
    assignees: [],
    commentCount: 0,
    labels: [],
  };
}

/**
 * Replace the `github:list-issues` IPC handler with one returning fixture data.
 * The fault registry only models error/delay, so the bulk-selection flow — which
 * needs a populated list — overrides the handler directly. The original handler
 * is stashed on `globalThis` and restored by {@link restoreListIssues}.
 */
export async function stubListIssues(
  app: ElectronApplication,
  issues: GitHubIssue[]
): Promise<void> {
  const response: GitHubListResponse<GitHubIssue> = {
    items: issues,
    pageInfo: { hasNextPage: false, endCursor: null },
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
    { channel: "github:list-issues", response }
  );
}

/**
 * Restore the real `github:list-issues` handler captured by {@link stubListIssues}.
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
  }, "github:list-issues");
}

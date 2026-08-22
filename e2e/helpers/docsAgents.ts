/**
 * Launch deterministic, offline agents into a chosen worktree.
 *
 * Driving the launcher tray puts the agent in whatever worktree the app
 * happens to consider active, which is not necessarily the card you clicked —
 * the delete-and-recover shot lost an afternoon to a rescue card that never
 * appeared because its worktree owned "0 terminals". `agent.launch` takes an
 * explicit `worktreeId`, so the placement is stated rather than inferred.
 *
 * Every agent here is the fake CLI from `fakeAgent.ts`: it drives the real
 * agent-state machine off an OSC 9;4 heartbeat, so `working` and `waiting` are
 * the states the app actually computes, with no API key and no network.
 */

import { expect, type Page } from "@playwright/test";
import { T_LONG, T_MEDIUM } from "./timeouts";
import { FAKE_AGENT_IDLE, ptyWrite } from "./fakeAgent";

export interface DocsWorktree {
  id: string;
  branch: string;
}

/** Every worktree the renderer knows about, via the E2E bridge. */
export async function listWorktrees(page: Page): Promise<DocsWorktree[]> {
  return page.evaluate(() => {
    const fn = (window as unknown as { __DAINTREE_E2E_WORKTREES__?: () => DocsWorktree[] })
      .__DAINTREE_E2E_WORKTREES__;
    return fn ? fn() : [];
  }) as Promise<DocsWorktree[]>;
}

/** Resolve a worktree id from a branch name, or throw with what was available. */
export async function worktreeIdFor(page: Page, branch: string): Promise<string> {
  const all = await listWorktrees(page);
  const match = all.find((w) => w.branch === branch);
  if (!match) {
    throw new Error(
      `no worktree for branch "${branch}" — have: ${all.map((w) => w.branch).join(", ")}`
    );
  }
  return match.id;
}

export interface LaunchOptions {
  /** Branch whose worktree the agent belongs to. Defaults to the active one. */
  branch?: string;
  /**
   * Pinned panel title. Also freezes the title against agent detection, which
   * keeps a multi-panel shot from renaming itself between states.
   */
  name?: string;
  /** Agent id. The fake binary answers as `claude` unless you install more. */
  agentId?: string;
}

/**
 * Launch one fake agent and wait until the app reports it `working`.
 * Returns the panel id, which `ptyWrite` needs.
 */
export async function launchDocsAgent(page: Page, options: LaunchOptions = {}): Promise<string> {
  const { branch, name, agentId = "claude" } = options;
  const worktreeId = branch ? await worktreeIdFor(page, branch) : undefined;

  const result = await page.evaluate(
    async (args) => {
      const dispatch = (
        window as unknown as {
          __daintreeDispatchAction?: (
            id: string,
            payload: unknown,
            opts: { source: string }
          ) => Promise<{ result?: { terminalId?: string } }>;
        }
      ).__daintreeDispatchAction;
      if (!dispatch) throw new Error("action dispatch bridge unavailable");
      return dispatch(
        "agent.launch",
        {
          agentId: args.agentId,
          location: "grid",
          force: true,
          ...(args.worktreeId ? { worktreeId: args.worktreeId } : {}),
          ...(args.name ? { name: args.name } : {}),
        },
        { source: "user" }
      );
    },
    { agentId, worktreeId, name }
  );

  const panelId = result?.result?.terminalId;
  if (!panelId) throw new Error("agent.launch returned no terminalId");

  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  await expect(panel).toBeVisible({ timeout: T_LONG });
  // The fake prints a trust prompt and only starts heartbeating after Enter.
  await page.waitForTimeout(T_MEDIUM);
  await ptyWrite(page, panelId, "\r");
  await expect
    .poll(() => panel.getAttribute("data-agent-state"), { timeout: T_LONG * 2 })
    .toBe("working");
  return panelId;
}

/**
 * Move a working agent to `waiting`.
 *
 * The transition is governed by an 8s idle debounce, and the echo of the token
 * itself resets the activity clock once, so the poll needs a window well above
 * the debounce rather than a fixed sleep.
 */
export async function parkAgent(page: Page, panelId: string): Promise<void> {
  const state = () =>
    page.locator(`[data-panel-id="${panelId}"]`).getAttribute("data-agent-state");

  await ptyWrite(page, panelId, `${FAKE_AGENT_IDLE}\r`);
  await page.waitForTimeout(2_000);
  // One resend. Writing to a PTY is fire-and-forget, and with several agents
  // running the first token occasionally lands while the pane is still
  // wiring up its reader — in which case the heartbeat never stops and the
  // poll below burns its whole budget waiting for a transition nothing asked
  // for.
  if ((await state()) === "working") {
    await ptyWrite(page, panelId, `${FAKE_AGENT_IDLE}\r`);
  }

  await expect
    .poll(state, { timeout: T_LONG * 6, intervals: [500, 1000, 2000] })
    .toBe("waiting");
}

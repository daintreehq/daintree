/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC payloads and window globals are untyped */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { existsSync, realpathSync } from "fs";
import path from "path";
import {
  launchApp,
  closeApp,
  openSecondWindow,
  getWindowPage,
  focusWindow,
  type AppContext,
} from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { dispatchAction } from "../../helpers/actions";
import {
  fakeAgentEnv,
  installFakeAgent,
  listFakeAgentLaunches,
  readFakeAgentLaunchLog,
  type FakeAgentLaunch,
} from "../../helpers/fakeAgent";
import { T_LONG } from "../../helpers/timeouts";

/**
 * The MCP consent seam end to end: a real Streamable HTTP client asks for
 * something the user has to approve, the approval dialog is raised in the
 * window that owns the target, and the answer the user clicks decides what
 * happens on disk. Nothing here enqueues a dialog directly — every dialog is
 * raised by a real tool call and every outcome is read from git or from the
 * tool's own reply.
 *
 * The second half proves the project's MCP tier is what an agent pane is
 * launched with: `off` hands the pane no bearer at all, `core` makes a
 * full-tier tool ask the user first, `full` runs it unasked. An api-key
 * client's surface is not governed by the project tier, so the tier journey
 * calls as the pane, with the bearer Daintree gave the pane.
 */

const PROTOCOL_VERSION = "2025-06-18";
const WORKSPACE_HEADER = "Daintree-Workspace-Id";
/** Sent on every api-key request so the dialog's "Requested by" row can be matched to this client. */
const PROBE_USER_AGENT = "daintree-consent-probe/1.0";
/** A safe, full-tier-only tool: above `core`, so a core pane has to ask for it. */
const FULL_ONLY_TOOL = "worktree.getCurrent";
const FULL_ONLY_TOOL_TITLE = "Get current worktree";
/**
 * How long a "no dialog" observation keeps watching after the call settles. A
 * dialog is raised within one renderer round trip of the dispatch reaching the
 * view; a call that should have asked would still be blocked on it here.
 */
const NO_DIALOG_DWELL_MS = 2_000;

interface Endpoint {
  port: number;
  authorization: string;
}

interface Session {
  endpoint: Endpoint;
  sessionId: string;
}

function parseBody(contentType: string, raw: string): any {
  if (!raw) return null;
  if (contentType.includes("text/event-stream")) {
    const payloads = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    return payloads.length === 0 ? null : JSON.parse(payloads[payloads.length - 1]);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function post(
  endpoint: Endpoint,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; sessionId: string | null; body: any }> {
  // Longer than the renderer's 30s confirmation deadline, so a call parked on
  // a dialog nobody answers comes back as the product's timeout, not ours.
  const res = await fetch(`http://127.0.0.1:${endpoint.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": PROBE_USER_AGENT,
      authorization: endpoint.authorization,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    body: parseBody(res.headers.get("content-type") ?? "", await res.text()),
  };
}

async function openSession(
  endpoint: Endpoint,
  clientName: string,
  workspaceId?: string
): Promise<Session> {
  const init = await post(
    endpoint,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0.0" },
      },
    },
    workspaceId ? { [WORKSPACE_HEADER]: workspaceId } : {}
  );
  if (!init.sessionId) {
    throw new Error(
      `initialize returned no session id (status ${init.status}): ${JSON.stringify(init.body)}`
    );
  }
  await post(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { "mcp-session-id": init.sessionId, "mcp-protocol-version": PROTOCOL_VERSION }
  );
  return { endpoint, sessionId: init.sessionId };
}

let nextRequestId = 100;

async function rpc(session: Session, method: string, params: unknown): Promise<any> {
  const res = await post(
    session.endpoint,
    { jsonrpc: "2.0", id: nextRequestId++, method, params },
    { "mcp-session-id": session.sessionId, "mcp-protocol-version": PROTOCOL_VERSION }
  );
  return res.body;
}

function callTool(session: Session, name: string, args: Record<string, unknown> = {}) {
  return rpc(session, "tools/call", { name, arguments: args });
}

/** Fails unless the reply is a JSON-RPC result that is not a tool error. */
function expectToolSuccess(body: any, name: string): void {
  expect(body?.error, `${name} returned an RPC error: ${JSON.stringify(body)}`).toBeUndefined();
  expect(body?.result, `${name} returned no result: ${JSON.stringify(body)}`).toBeTruthy();
  expect(body.result.isError, `${name} failed: ${JSON.stringify(body)}`).not.toBe(true);
}

/** The `code` a tool error carries, failing the test if the reply is not a tool error. */
function toolErrorCode(body: any): string | undefined {
  expect(body?.result?.isError, `expected a tool error: ${JSON.stringify(body)}`).toBe(true);
  return toolPayload(body)?.code;
}

/** A tool's result payload, failing the test with the whole reply on any error. */
async function callOk(session: Session, name: string, args: Record<string, unknown> = {}) {
  const body = await callTool(session, name, args);
  expectToolSuccess(body, name);
  return toolPayload(body);
}

function toolPayload(body: any): any {
  const structured = body?.result?.structuredContent;
  if (structured !== undefined) return structured;
  const text = body?.result?.content?.[0]?.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function toolNames(session: Session): Promise<string[]> {
  const listed = await rpc(session, "tools/list", {});
  return (listed?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The linked worktrees git itself records for a repository, canonicalised. */
function gitWorktrees(repoDir: string): string[] {
  const out = execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => canonical(line.slice("worktree ".length)));
}

/** Whether a worktree is still there as far as the OS and git are concerned. */
function worktreeOnDisk(repoDir: string, worktreePath: string): { dir: boolean; git: boolean } {
  return {
    dir: existsSync(worktreePath),
    git: gitWorktrees(repoDir).includes(canonical(worktreePath)),
  };
}

/** The approval dialog for one action, by the title the host gives it. */
function approvalDialog(page: Page, actionTitle: string): Locator {
  return page
    .locator('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')
    .filter({ hasText: actionTitle });
}

/**
 * Runs `call` while watching both windows for any modal naming `actionTitle`,
 * and keeps watching for a dwell after it settles. Returns the call's reply
 * and whether any sample ever saw such a dialog.
 */
async function callWatchingForDialog(
  pages: Page[],
  actionTitle: string,
  call: () => Promise<any>
): Promise<{ reply: any; sawDialog: boolean }> {
  let settled = false;
  let sawDialog = false;
  // Both outcomes are captured at once, so a failed fetch is reported after
  // the watch instead of surfacing mid-loop as an unhandled rejection.
  const pending = call().then(
    (reply) => ({ reply, error: undefined as unknown }),
    (error: unknown) => ({ reply: undefined, error: error ?? new Error("call rejected") })
  );
  void pending.then(() => {
    settled = true;
  });
  let dwellUntil = Number.POSITIVE_INFINITY;
  while (Date.now() < dwellUntil) {
    for (const page of pages) {
      if ((await approvalDialog(page, actionTitle).count()) > 0) sawDialog = true;
    }
    if (settled && dwellUntil === Number.POSITIVE_INFINITY) {
      dwellUntil = Date.now() + NO_DIALOG_DWELL_MS;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const outcome = await pending;
  if (outcome.error !== undefined) throw outcome.error;
  return { reply: outcome.reply, sawDialog };
}

let ctx: AppContext;
let pageA: Page;
let pageB: Page;
let windowIdA: number;
let windowIdB: number;
let repoA: string;
let repoB: string;
let workspaceA: string;
let workspaceB: string;
let binDir: string;
let apiKey: string;
let port: number;
let fixtureCleanups: Array<() => void> = [];

async function setProjectTier(tier: "off" | "core" | "full"): Promise<void> {
  await pageA.evaluate(
    async ([projectId, nextTier]) => {
      const project = (window as any).electron.project;
      const settings = (await project.getSettings(projectId)) ?? { runCommands: [] };
      await project.saveSettings(projectId, { ...settings, daintreeMcpTier: nextTier });
    },
    [workspaceA, tier] as const
  );
  await expect
    .poll(() =>
      pageA.evaluate(
        async (projectId) =>
          (await (window as any).electron.project.getSettings(projectId))?.daintreeMcpTier,
        workspaceA
      )
    )
    .toBe(tier);
}

/** Launch the fake Claude in project A and return what it recorded at start. */
async function launchPane(name: string): Promise<FakeAgentLaunch> {
  const before = new Set(listFakeAgentLaunches(binDir).map((launch) => launch.paneId));
  const launched = await dispatchAction<{ terminalId: string }>(
    pageA,
    "agent.launch",
    { agentId: "claude", location: "grid", name },
    { source: "test" }
  );
  expect(launched.ok, JSON.stringify(launched)).toBe(true);
  let found: FakeAgentLaunch | undefined;
  await expect
    .poll(
      () => {
        found = listFakeAgentLaunches(binDir).find((launch) => !before.has(launch.paneId));
        return found !== undefined;
      },
      { timeout: T_LONG * 2, intervals: [250, 500] }
    )
    .toBe(true);
  return found!;
}

/** Everything a non-assistant session is shown, whatever its tier. */
function expectOwnedFormsOnly(names: string[]): void {
  expect(names).toContain("terminal.closeOwned");
  expect(names).toContain("worktree.deleteOwned");
  expect(names).not.toContain("terminal.close");
  expect(names).not.toContain("terminal.closeAll");
  expect(names).not.toContain("worktree.delete");
}

test.describe.serial("MCP: consent dialogs and project tiers, end to end", () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const fixtures = createFixtureRepos(2);
    fixtureCleanups = fixtures.map((f) => f.cleanup);
    [repoA, repoB] = fixtures.map((f) => f.dir);
    // Installed beside project B so project A's worktrees start from a clean tree.
    binDir = installFakeAgent(repoB, { perPane: true });

    ctx = await launchApp({ env: fakeAgentEnv(binDir) });
    pageA = await openAndOnboardProject(ctx.app, ctx.window, repoA, "mcp-consent-A");
    ctx.window = pageA;
    windowIdA = await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);

    const handle = await openSecondWindow(ctx.app, pageA, { projectPath: repoB });
    windowIdB = handle.windowId;
    pageB = await getWindowPage(ctx.app, windowIdB);

    const readWorkspaceId = (page: Page) =>
      page.evaluate(() => (window as any).__DAINTREE_INITIAL_PROJECT__?.id ?? null);
    await expect
      .poll(async () => (await readWorkspaceId(pageA)) && (await readWorkspaceId(pageB)), {
        timeout: T_LONG,
        intervals: [200, 400, 800],
      })
      .toBeTruthy();
    workspaceA = (await readWorkspaceId(pageA))!;
    workspaceB = (await readWorkspaceId(pageB))!;
    expect(workspaceA).not.toBe(workspaceB);

    await pageA.evaluate(() => (window as any).electron.mcpServer.setEnabled(true));
    await expect
      .poll(
        async () => {
          const status = await pageA.evaluate(() => (window as any).electron.mcpServer.getStatus());
          return Boolean(status.port && status.apiKey);
        },
        { timeout: T_LONG, intervals: [200, 400, 800] }
      )
      .toBe(true);
    const status = await pageA.evaluate(() => (window as any).electron.mcpServer.getStatus());
    port = status.port;
    apiKey = status.apiKey;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("deleting its own worktree waits on the user: Cancel keeps it on disk, confirm removes it", async () => {
    test.setTimeout(180_000);
    const endpoint = { port, authorization: `Bearer ${apiKey}` };
    const session = await openSession(endpoint, "consent-probe");
    expectOwnedFormsOnly(await toolNames(session));

    await focusWindow(ctx.app, windowIdA, pageA);
    const created = await callOk(session, "worktree.createWithRecipe", {
      source: { kind: "newBranch", branchName: "mcp-consent-delete" },
    });
    const worktreePath: string = created.worktreePath;
    expect(created.worktreeId, JSON.stringify(created)).toBeTruthy();

    // An unbound session goes wherever focus is, so the owning window is read
    // off git rather than assumed; the dialog has to follow the worktree.
    const inA = gitWorktrees(repoA).includes(canonical(worktreePath));
    const inB = gitWorktrees(repoB).includes(canonical(worktreePath));
    expect({ inA, inB }, `created at ${worktreePath}`).not.toEqual({ inA: false, inB: false });
    const [ownerRepo, ownerPage, otherPage] = inA ? [repoA, pageA, pageB] : [repoB, pageB, pageA];
    await expect
      .poll(() => worktreeOnDisk(ownerRepo, worktreePath))
      .toEqual({ dir: true, git: true });

    // Fired unawaited: the call does not return until someone answers.
    const declined = callTool(session, "worktree.deleteOwned", { worktreeId: created.worktreeId });
    const dialog = approvalDialog(ownerPage, "Delete worktree");
    await expect(dialog).toBeVisible({ timeout: T_LONG });
    await expect(approvalDialog(otherPage, "Delete worktree")).toHaveCount(0);
    // Provenance: this client, by its user agent and its key's last characters.
    await expect(dialog).toContainText("Requested by");
    await expect(dialog).toContainText(PROBE_USER_AGENT);
    await expect(dialog).toContainText(apiKey.slice(-4));
    // Picking a worktree is part of what is approved, so it cannot be waved
    // through for the rest of the session — and an api-key client is not offered it.
    await expect(
      dialog.getByRole("checkbox", { name: "Allow for the rest of this session" })
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    expect(toolErrorCode(await declined)).toBe("USER_REJECTED");
    await expect(dialog).toHaveCount(0);
    expect(worktreeOnDisk(ownerRepo, worktreePath)).toEqual({ dir: true, git: true });

    let approvalSettled = false;
    const approved = callTool(session, "worktree.deleteOwned", {
      worktreeId: created.worktreeId,
    }).finally(() => {
      approvalSettled = true;
    });
    const again = approvalDialog(ownerPage, "Delete worktree");
    await expect(again).toBeVisible({ timeout: T_LONG });
    await expect(approvalDialog(otherPage, "Delete worktree")).toHaveCount(0);
    // Enabled only once the preview has landed and the destructive cooldown has run.
    const confirm = again.getByRole("button", { name: "Delete worktree", exact: true });
    await expect(confirm).toBeEnabled({ timeout: T_LONG });
    // Still parked on the answer, with nothing deleted yet.
    expect(approvalSettled, "the delete returned before the user answered").toBe(false);
    expect(worktreeOnDisk(ownerRepo, worktreePath)).toEqual({ dir: true, git: true });
    await confirm.click();

    expectToolSuccess(await approved, "worktree.deleteOwned");
    await expect
      .poll(() => worktreeOnDisk(ownerRepo, worktreePath), { timeout: T_LONG })
      .toEqual({ dir: false, git: false });
  });

  test("a workspace-bound session's delete is refused before any dialog is raised", async () => {
    test.setTimeout(120_000);
    const endpoint = { port, authorization: `Bearer ${apiKey}` };
    const bound = await openSession(endpoint, "bound-consent-probe", workspaceA);
    const names = await toolNames(bound);
    expect(names).toContain("worktree.createWithRecipe");
    expect(names).not.toContain("worktree.deleteOwned");

    const created = await callOk(bound, "worktree.createWithRecipe", {
      source: { kind: "newBranch", branchName: "mcp-consent-bound" },
    });
    const worktreePath: string = created.worktreePath;
    await expect.poll(() => worktreeOnDisk(repoA, worktreePath)).toEqual({ dir: true, git: true });

    const { reply, sawDialog } = await callWatchingForDialog(
      [pageA, pageB],
      "Delete worktree",
      () => callTool(bound, "worktree.deleteOwned", { worktreeId: created.worktreeId })
    );
    expect(toolErrorCode(reply)).toBe("CONFIRMATION_REQUIRED");
    expect(JSON.stringify(reply)).toContain("workspace-bound");
    expect(sawDialog, "a bound session's delete raised an approval dialog").toBe(false);
    expect(worktreeOnDisk(repoA, worktreePath)).toEqual({ dir: true, git: true });
  });

  test("tier off launches an agent pane with no Daintree bearer", async () => {
    await setProjectTier("off");
    const launch = await launchPane("tier-off");
    expect(launch.mcpToken).toBeNull();
    expect(launch.argv).not.toContain("--mcp-config");
    const record = readFakeAgentLaunchLog(binDir).find((entry) => entry.paneId === launch.paneId);
    expect(record?.present?.DAINTREE_MCP_TOKEN, JSON.stringify(record?.present)).toBe(false);
  });

  test("tier core: a full-tier tool asks the user in the pane's own window, and a session approval sticks", async () => {
    test.setTimeout(180_000);
    await setProjectTier("core");
    const launch = await launchPane("tier-core");
    expect(launch.mcpToken, "a core pane was launched without a Daintree bearer").toBeTruthy();
    expect(launch.argv).toContain("--mcp-config");
    const pane = await openSession(
      { port, authorization: `Bearer ${launch.mcpToken}` },
      "core-pane"
    );

    const names = await toolNames(pane);
    expectOwnedFormsOnly(names);
    expect(names).toContain("worktree.createWithRecipe");
    // Listed, because a pane may ask for anything up to the full surface.
    expect(names).toContain(FULL_ONLY_TOOL);
    expect((await callOk(pane, "mcp.surface")).tier).toBe("core");

    // The pane is bound to project A; the question must go there, not to the
    // window that happens to have focus. Premise: focus-following routing now
    // points at B, as an unbound api-key session sees it — otherwise a dialog
    // in A would not tell a bound route from a focused one.
    await focusWindow(ctx.app, windowIdB, pageB);
    const canary = await openSession({ port, authorization: `Bearer ${apiKey}` }, "focus-canary");
    await expect
      .poll(async () => (await callOk(canary, "actions.getContext"))?.projectId, {
        timeout: T_LONG,
        intervals: [200, 400, 800],
      })
      .toBe(workspaceB);

    const declined = callTool(pane, FULL_ONLY_TOOL);
    const dialog = approvalDialog(pageA, FULL_ONLY_TOOL_TITLE);
    await expect(dialog).toBeVisible({ timeout: T_LONG });
    await expect(approvalDialog(pageB, FULL_ONLY_TOOL_TITLE)).toHaveCount(0);
    await expect(dialog).toContainText("beyond what this project's MCP tier lets agents do");
    await expect(dialog).toContainText("Agent in a terminal pane");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(toolErrorCode(await declined)).toBe("USER_REJECTED");
    await expect(dialog).toHaveCount(0);

    const approved = callTool(pane, FULL_ONLY_TOOL);
    const again = approvalDialog(pageA, FULL_ONLY_TOOL_TITLE);
    await expect(again).toBeVisible({ timeout: T_LONG });
    await expect(approvalDialog(pageB, FULL_ONLY_TOOL_TITLE)).toHaveCount(0);
    const allow = again.getByRole("checkbox", { name: "Allow for the rest of this session" });
    await allow.check();
    await expect(allow).toBeChecked();
    const confirm = again.getByRole("button", { name: FULL_ONLY_TOOL_TITLE, exact: true });
    await expect(confirm).toBeEnabled({ timeout: T_LONG });
    await confirm.click();
    const answer = await approved;
    expectToolSuccess(answer, FULL_ONLY_TOOL);
    expect(JSON.stringify(toolPayload(answer))).toContain(path.basename(repoA));

    // Same session, same tool: the approval covers it without asking again.
    const { reply, sawDialog } = await callWatchingForDialog(
      [pageA, pageB],
      FULL_ONLY_TOOL_TITLE,
      () => callTool(pane, FULL_ONLY_TOOL)
    );
    expectToolSuccess(reply, FULL_ONLY_TOOL);
    expect(JSON.stringify(toolPayload(reply))).toContain(path.basename(repoA));
    expect(sawDialog, "a session approval did not cover the next call").toBe(false);

    await focusWindow(ctx.app, windowIdA, pageA);
  });

  test("tier full: the same tool runs for a pane without asking", async () => {
    test.setTimeout(120_000);
    await setProjectTier("full");
    const launch = await launchPane("tier-full");
    expect(launch.mcpToken, "a full pane was launched without a Daintree bearer").toBeTruthy();
    const pane = await openSession(
      { port, authorization: `Bearer ${launch.mcpToken}` },
      "full-pane"
    );

    const names = await toolNames(pane);
    expectOwnedFormsOnly(names);
    expect(names).toContain(FULL_ONLY_TOOL);
    expect((await callOk(pane, "mcp.surface")).tier).toBe("full");

    const { reply, sawDialog } = await callWatchingForDialog(
      [pageA, pageB],
      FULL_ONLY_TOOL_TITLE,
      () => callTool(pane, FULL_ONLY_TOOL)
    );
    expectToolSuccess(reply, FULL_ONLY_TOOL);
    expect(JSON.stringify(toolPayload(reply))).toContain(path.basename(repoA));
    expect(sawDialog, "a full-tier pane was asked to approve a full-tier tool").toBe(false);
  });
});

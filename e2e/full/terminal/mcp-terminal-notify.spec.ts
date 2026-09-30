/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC payloads and window globals are untyped */
import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject } from "../../helpers/workflows";
import { getTerminalTextById } from "../../helpers/terminal";
import { dispatchAction } from "../../helpers/actions";
import { sameFilesystemEntry } from "../../helpers/resource-lifecycle";
import {
  fakeAgentEnv,
  installFakeAgent,
  listFakeAgentLaunches,
  ptyWrite,
  readFakeAgentLaunchLog,
  readFakeAgentStdin,
  sendFakeAgentCommand,
  sendFakeAgentHandback,
  type FakeAgentLaunch,
} from "../../helpers/fakeAgent";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import {
  MIN_NOTIFY_INTERVAL_MS,
  NOTIFY_COALESCE_MS,
  NOTIFY_SETTLE_GRACE_MS,
  NOTIFY_TARGET_SETTLE_MS,
} from "../../../shared/types/terminalNotify";

/**
 * Terminal notices end to end, received by the real Daintree Assistant in the
 * sidebar: an assistant lane asks, over its own MCP bearer, to be told when an
 * agent it prompted stops working, and Daintree types one line into that
 * lane's prompt — not into a second lane, and not into the worker.
 *
 * Every terminal runs the fake `claude` in per-pane mode, so each one's stdin
 * is logged to its own file: what reached a lane's prompt is read off disk,
 * not off a screen that could belong to whichever project is showing. The
 * worker's state is driven through its control file, never by typing into it,
 * so the only input a pane receives is what Daintree chose to send.
 */

const PROTOCOL_VERSION = "2025-06-18";
/**
 * One notice's worth of time: the 8s idle debounce before the worker reads as
 * waiting, the notice's 2s settle, the 2s coalesce, and the asking pane's own
 * settle grace — with the same CI scaling as every other timeout.
 */
const T_NOTICE = T_LONG * 4;
/** Every gate a notice passes before it is typed, so one that is coming has come. */
const NOTICE_DWELL_MS =
  NOTIFY_TARGET_SETTLE_MS + NOTIFY_COALESCE_MS + NOTIFY_SETTLE_GRACE_MS + MIN_NOTIFY_INTERVAL_MS;
/** A trashed pane's PTY is killed when its trash entry expires; shortened for the launch. */
const TRASH_TTL_MS = 3_000;

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
  headers: Record<string, string> = {},
  timeoutMs = T_LONG * 2
): Promise<{ sessionId: string | null; body: any }> {
  const res = await fetch(`http://127.0.0.1:${endpoint.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: endpoint.authorization,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    sessionId: res.headers.get("mcp-session-id"),
    body: parseBody(res.headers.get("content-type") ?? "", await res.text()),
  };
}

async function openSession(endpoint: Endpoint, clientName: string): Promise<Session> {
  const init = await post(endpoint, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    },
  });
  if (!init.sessionId) {
    throw new Error(`initialize returned no session id: ${JSON.stringify(init.body)}`);
  }
  await post(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { "mcp-session-id": init.sessionId, "mcp-protocol-version": PROTOCOL_VERSION }
  );
  return { endpoint, sessionId: init.sessionId };
}

let nextRequestId = 100;

async function rpc(
  session: Session,
  method: string,
  params: unknown,
  timeoutMs?: number
): Promise<any> {
  const res = await post(
    session.endpoint,
    { jsonrpc: "2.0", id: nextRequestId++, method, params },
    { "mcp-session-id": session.sessionId, "mcp-protocol-version": PROTOCOL_VERSION },
    timeoutMs
  );
  return res.body;
}

/** A tool call's result, failing the test with the whole reply on a tool error. */
async function callOk(
  session: Session,
  name: string,
  args: Record<string, unknown>,
  timeoutMs?: number
) {
  const body = await rpc(session, "tools/call", { name, arguments: args }, timeoutMs);
  expect(body?.result?.isError, `${name} failed: ${JSON.stringify(body)}`).not.toBe(true);
  if (body.result.structuredContent !== undefined) return body.result.structuredContent;
  // A tool without an output schema answers in its text block alone.
  const text = body.result.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : undefined;
}

async function agentState(page: Page, panelId: string): Promise<string | null> {
  return page
    .locator(`[data-panel-id="${panelId}"]`)
    .getAttribute("data-agent-state")
    .catch(() => null);
}

async function waitForAgentState(page: Page, panelId: string, state: string): Promise<void> {
  await expect
    .poll(() => agentState(page, panelId), { timeout: T_NOTICE, intervals: [250, 500, 1000] })
    .toBe(state);
}

/** Answer the fake CLI's trust dialog, the one keystroke a test ever types. */
async function trust(page: Page, panelId: string): Promise<void> {
  await expect
    .poll(() => getTerminalTextById(page, panelId), { timeout: T_LONG, intervals: [200, 500] })
    .toContain("Enter to confirm");
  expect(await ptyWrite(page, panelId, "\r")).toBe(true);
  await expect
    .poll(() => getTerminalTextById(page, panelId), { timeout: T_LONG, intervals: [200, 500] })
    .toContain("FAKE_CLAUDE_READY");
}

/**
 * Every `Daintree:` line a pane has had submitted to its prompt. The fake CLI
 * reads a cooked tty, so input reaches it a line at a time, on Enter; a
 * trailing fragment with no newline behind it was typed but not submitted,
 * and does not count.
 */
function noticesFor(binDir: string, paneId: string): string[] {
  const lines = readFakeAgentStdin(binDir, paneId).split(/\r\n|\r|\n/);
  lines.pop();
  return lines
    .map((line) => line.replaceAll("\u001b[200~", "").replaceAll("\u001b[201~", "").trim())
    .filter((line) => line.startsWith("Daintree:"));
}

let ctx: AppContext;
let page: Page;
let binDir: string;
let repoB: string;
let cleanups: Array<() => void> = [];
let port: number;
let assistantId: string;
let otherLaneId: string;
let assistant: Session;
let workerId: string;

/** The fake CLI Daintree starts next, once it has recorded where it runs. */
async function nextLaunch(start: () => Promise<void>): Promise<FakeAgentLaunch> {
  const before = new Set(listFakeAgentLaunches(binDir).map((launch) => launch.paneId));
  await start();
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

/** Open an assistant lane in the sidebar and settle it at its prompt. */
async function startAssistantLane(click: () => Promise<void>): Promise<FakeAgentLaunch> {
  const launch = await nextLaunch(click);
  expect(launch.mcpToken, "the assistant lane was launched without a Daintree bearer").toBeTruthy();
  await trust(page, launch.paneId);
  await sendFakeAgentCommand(binDir, "idle", T_MEDIUM, launch.paneId);
  return launch;
}

/** The state Daintree reports for each terminal, as the orchestrator reads it. */
async function agentStates(session: Session, terminalIds: string[]): Promise<string[]> {
  const status = await callOk(session, "terminal.getStatus", { terminalIds });
  return terminalIds.map(
    (id) =>
      (status?.terminals ?? []).find((entry: any) => entry.terminalId === id)?.agentState ?? "none"
  );
}

/** The OS pid of the fake CLI a pane started. */
function pidOf(paneId: string): number {
  const record = readFakeAgentLaunchLog(binDir).find((launch) => launch.paneId === paneId);
  if (!record) throw new Error(`no launch record for ${paneId}`);
  return record.pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

test.describe.serial("MCP: terminal notices reach the pane that asked", () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const a = createFixtureRepo({ name: "notify-assistant" });
    // Its second worktree is where the orchestrator places one of its workers.
    const b = createFixtureRepo({ name: "notify-elsewhere", withFeatureBranch: true });
    cleanups = [a.cleanup, b.cleanup];
    repoB = b.dir;
    binDir = installFakeAgent(a.dir, { perPane: true });

    ctx = await launchApp({
      env: { ...fakeAgentEnv(binDir), DAINTREE_E2E_TRASH_TTL_MS: String(TRASH_TTL_MS) },
    });
    page = await openAndOnboardProject(ctx.app, ctx.window, a.dir, "notify-assistant");
    ctx.window = page;

    await page.evaluate(() => (window as any).electron.mcpServer.setEnabled(true));
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => (window as any).electron.mcpServer.getStatus())).port,
        {
          timeout: T_LONG,
          intervals: [200, 400, 800],
        }
      )
      .toBeTruthy();
    port = (await page.evaluate(() => (window as any).electron.mcpServer.getStatus())).port;

    // The assistant runs whichever agent the user picked; this machine may have
    // several installed, so pick Claude the way the settings tab stores it.
    await page.evaluate(() => {
      const key = "help-panel-storage";
      let blob: { state?: Record<string, unknown>; version?: number };
      try {
        blob = JSON.parse(window.localStorage.getItem(key) ?? "{}");
      } catch {
        blob = {};
      }
      blob.state = { ...(blob.state ?? {}), preferredAgentId: "claude" };
      blob.version = blob.version ?? 6;
      window.localStorage.setItem(key, JSON.stringify(blob));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[aria-label="Toggle sidebar"]')).toBeVisible({ timeout: T_LONG });

    // The Daintree Assistant, opened in the sidebar and started the way a user
    // starts it, then a second lane beside it.
    await dispatchAction(page, "help.togglePanel", undefined, { source: "test" });
    const first = await startAssistantLane(() =>
      page.locator('[data-testid="help-start-assistant"]').click()
    );
    const second = await startAssistantLane(() =>
      page.locator('[aria-label="New session"]').click()
    );
    assistantId = first.paneId;
    otherLaneId = second.paneId;
    expect(otherLaneId).not.toBe(assistantId);

    assistant = await openSession(
      { port, authorization: `Bearer ${first.mcpToken}` },
      "daintree-assistant-lane"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of cleanups) cleanup();
  });

  test("a launch with notify types one line into the assistant lane that asked, and nowhere else", async () => {
    test.setTimeout(180_000);
    const launched = await callOk(assistant, "agent.launch", {
      agentId: "claude",
      prompt: "Plan the refactor",
      name: "Worker",
      notify: true,
    });
    workerId = launched.terminalId;
    expect(workerId).toBeTruthy();
    // The worker is a real launch that carried its prompt, not a bare pane.
    await expect
      .poll(
        () =>
          listFakeAgentLaunches(binDir)
            .find((launch) => launch.paneId === workerId)
            ?.argv.join(" ") ?? "",
        { timeout: T_LONG }
      )
      .toContain("Plan the refactor");

    await trust(page, workerId);
    await waitForAgentState(page, workerId, "working");
    expect(noticesFor(binDir, assistantId)).toEqual([]);

    await sendFakeAgentCommand(binDir, "idle", T_MEDIUM, workerId);
    await expect
      .poll(() => noticesFor(binDir, assistantId), { timeout: T_NOTICE, intervals: [500, 1000] })
      .toEqual([`Daintree: terminal ${workerId} stopped working, now waiting at its prompt.`]);
    expect(noticesFor(binDir, otherLaneId)).toEqual([]);
    expect(noticesFor(binDir, workerId)).toEqual([]);
  });

  test("notifyWhenIdle arms on a working agent and echoes the caller's note", async () => {
    test.setTimeout(180_000);
    await sendFakeAgentCommand(binDir, "work", T_MEDIUM, workerId);
    await waitForAgentState(page, workerId, "working");

    const armed = await callOk(assistant, "terminal.notifyWhenIdle", {
      terminalId: workerId,
      note: "run the reviewer next",
    });
    expect(armed).toEqual({ armed: true, terminalId: workerId });

    await sendFakeAgentCommand(binDir, "idle", T_MEDIUM, workerId);
    await expect
      .poll(() => noticesFor(binDir, assistantId).length, {
        timeout: T_NOTICE,
        intervals: [500, 1000],
      })
      .toBe(2);
    expect(noticesFor(binDir, assistantId)[1]).toBe(
      `Daintree: terminal ${workerId} stopped working, now waiting at its prompt. Your note: "run the reviewer next".`
    );

    // A terminal that is not working answers at once and arms nothing.
    await waitForAgentState(page, workerId, "waiting");
    const idle = await callOk(assistant, "terminal.notifyWhenIdle", { terminalId: workerId });
    expect(idle).toMatchObject({ armed: false, terminalId: workerId, state: "waiting" });
  });

  test("a notice armed in one project arrives while another project is on screen", async () => {
    test.setTimeout(240_000);
    await callOk(assistant, "terminal.sendCommand", {
      terminalId: workerId,
      command: "Carry on with step two",
      notify: true,
    });
    await expect
      .poll(() => readFakeAgentStdin(binDir, workerId), { timeout: T_LONG })
      .toContain("Carry on with step two");
    await sendFakeAgentCommand(binDir, "work", T_MEDIUM, workerId);
    await waitForAgentState(page, workerId, "working");

    // The user moves to another project, so nothing in project A is on screen.
    // The helper returns once the window shows project B.
    const other = await addAndSwitchToProject(ctx.app, page, repoB, "notify-elsewhere");
    ctx.window = other;

    await sendFakeAgentCommand(binDir, "idle", T_MEDIUM, workerId);
    await expect
      .poll(() => noticesFor(binDir, assistantId).length, {
        timeout: T_NOTICE,
        intervals: [500, 1000],
      })
      .toBe(3);
    expect(noticesFor(binDir, assistantId)[2]).toBe(
      `Daintree: terminal ${workerId} stopped working, now waiting at its prompt.`
    );

    // A terminal in the project now on screen is not one the assistant may
    // ask about: it gets the same answer as an id that does not exist.
    const elsewhere = await nextLaunch(async () => {
      const launched = await other.evaluate(async () => {
        const run = (window as any).__daintreeDispatchAction;
        return run("agent.launch", { agentId: "claude", name: "Elsewhere" }, { source: "test" });
      });
      expect(launched?.ok, JSON.stringify(launched)).toBe(true);
    });
    // Running, so a refusal is about its project and not about a spawn in flight.
    for (const terminalId of [elsewhere.paneId, "no-such-terminal"]) {
      const refused = await rpc(assistant, "tools/call", {
        name: "terminal.notifyWhenIdle",
        arguments: { terminalId },
      });
      expect(refused?.result?.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain("NOTIFY_TARGET_UNAVAILABLE");
    }
    expect(noticesFor(binDir, otherLaneId)).toEqual([]);
  });

  test("an api-key client is neither shown notify nor allowed it", async () => {
    const status = await ctx.window.evaluate(() => (window as any).electron.mcpServer.getStatus());
    const external = await openSession(
      { port, authorization: `Bearer ${status.apiKey}` },
      "api-key-client"
    );

    const listed = await rpc(external, "tools/list", {});
    const launch = (listed?.result?.tools ?? []).find((tool: any) => tool.name === "agent.launch");
    expect(launch, "agent.launch is on the external surface").toBeTruthy();
    expect(Object.keys(launch.inputSchema.properties)).not.toContain("notify");

    const refused = await rpc(external, "tools/call", {
      name: "agent.launch",
      arguments: { agentId: "claude", prompt: "Plan it", notify: true },
    });
    expect(refused?.result?.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("NOTIFY_NOT_ELIGIBLE");
  });

  test("an orchestrator pane launches its own workers, gets each handback, and closes only what it launched", async () => {
    test.setTimeout(480_000);
    // Project B is on screen. Its tier gives an agent pane launched there its own bearer.
    const view = ctx.window;
    await view.evaluate(async () => {
      const current = await (window as any).electron.project.getCurrent();
      const settings = (await (window as any).electron.project.getSettings(current.id)) ?? {
        runCommands: [],
      };
      await (window as any).electron.project.saveSettings(current.id, {
        ...settings,
        daintreeMcpTier: "core",
      });
    });
    await expect
      .poll(() =>
        view.evaluate(async () => {
          const current = await (window as any).electron.project.getCurrent();
          return (await (window as any).electron.project.getSettings(current.id))?.daintreeMcpTier;
        })
      )
      .toBe("core");

    const launchAsUser = (name: string) =>
      nextLaunch(async () => {
        const launched = await dispatchAction(
          view,
          "agent.launch",
          { agentId: "claude", name },
          { source: "test" }
        );
        expect(launched?.ok, JSON.stringify(launched)).toBe(true);
      });
    const orchestratorLaunch = await launchAsUser("Orchestrator");
    const orchestratorId = orchestratorLaunch.paneId;
    expect(orchestratorLaunch.mcpToken, "a core-tier pane gets its own bearer").toBeTruthy();
    await trust(view, orchestratorId);
    await sendFakeAgentCommand(binDir, "idle", T_MEDIUM, orchestratorId);
    // A pane the user started beside it, which the orchestrator never launched.
    // Settled at its prompt, so a notice sent to it by mistake would be logged.
    const bystanderId = (await launchAsUser("Bystander")).paneId;
    await trust(view, bystanderId);
    await sendFakeAgentCommand(binDir, "idle", T_MEDIUM, bystanderId);

    const orchestrator = await openSession(
      { port, authorization: `Bearer ${orchestratorLaunch.mcpToken}` },
      "orchestrator-pane"
    );
    const { worktrees } = await callOk(orchestrator, "worktree.list", {});
    const mainTree = worktrees.find((tree: any) => tree.isMain);
    const featureTree = worktrees.find((tree: any) => tree.branch === "feature/test-branch");
    expect(mainTree && featureTree, JSON.stringify(worktrees)).toBeTruthy();

    // One worker per worktree, launched by the orchestrator over its own bearer.
    const workers: Array<{ id: string; label: string; path: string; summary: string }> = [];
    for (const [label, tree] of [
      ["alpha", mainTree],
      ["beta", featureTree],
    ] as const) {
      const launched = await callOk(orchestrator, "agent.launchMany", {
        agentIds: ["claude"],
        prompt: `Survey the ${label} worktree`,
        name: label,
        worktreeId: tree.id,
        notify: true,
      });
      expect(launched.results, JSON.stringify(launched)).toHaveLength(1);
      expect(launched.results[0]).toMatchObject({ target: "claude", ok: true });
      const id = launched.results[0].result.terminalId as string;
      expect(id).toBeTruthy();
      workers.push({ id, label, path: tree.path, summary: `${label} survey: 3 files need tests` });
    }
    const workerIds = workers.map((worker) => worker.id);
    expect(new Set([...workerIds, orchestratorId, bystanderId]).size).toBe(4);

    for (const worker of workers) {
      // The CLI really started in its worktree with the launch prompt.
      await expect
        .poll(() => readFakeAgentLaunchLog(binDir).find((launch) => launch.paneId === worker.id), {
          timeout: T_LONG * 2,
        })
        .toBeTruthy();
      const record = readFakeAgentLaunchLog(binDir).find((launch) => launch.paneId === worker.id)!;
      expect(sameFilesystemEntry(record.cwd, worker.path), `${record.cwd} vs ${worker.path}`).toBe(
        true
      );
      expect(record.argv.join(" ")).toContain(`Survey the ${worker.label} worktree`);
      // Past the trust dialog; the acknowledgement proves the keystroke landed.
      expect(await ptyWrite(view, worker.id, "\r")).toBe(true);
      await sendFakeAgentCommand(binDir, "work", T_LONG, worker.id);
    }
    await expect
      .poll(() => agentStates(orchestrator, workerIds), {
        timeout: T_NOTICE,
        intervals: [250, 500, 1000],
      })
      .toEqual(["working", "working"]);

    // Each worker stops in turn: one line for it, typed into the orchestrator.
    const noticeLine = (id: string) =>
      `Daintree: terminal ${id} stopped working, now waiting at its prompt.`;
    const expected: string[] = [];
    for (const worker of workers) {
      await sendFakeAgentCommand(binDir, "idle", T_MEDIUM, worker.id);
      expected.push(noticeLine(worker.id));
      await expect
        .poll(() => noticesFor(binDir, orchestratorId), {
          timeout: T_NOTICE,
          intervals: [500, 1000],
        })
        .toEqual(expected);
    }

    // Busy before the next turn lands, so neither reads as settled before it
    // prints its marker however slowly the runner gets to it.
    for (const worker of workers) await sendFakeAgentCommand(binDir, "work", T_MEDIUM, worker.id);

    // The next turn, held open until every worker has answered. Its own
    // notices hold with it, and go once the call itself has the answers.
    const notifyState = () =>
      view.evaluate(
        (id) => (window as any).electron.mcpServer.getPaneNotifyState(id),
        orchestratorId
      );
    const sending = callOk(
      orchestrator,
      "terminal.sendCommandMany",
      {
        sends: workers.map((worker) => ({
          terminalId: worker.id,
          command: `Report on the ${worker.label} worktree`,
        })),
        handback: true,
        waitForReply: true,
        notify: true,
        waitSeconds: 180,
      },
      200_000
    );
    sending.catch(() => {});
    await expect
      .poll(async () => (await notifyState())?.pendingCount ?? 0, { timeout: T_LONG })
      .toBe(2);
    const handbacks = await Promise.all(
      workers.map(async (worker) => {
        await expect
          .poll(() => readFakeAgentStdin(binDir, worker.id), { timeout: T_NOTICE })
          .toMatch(
            new RegExp(`Report on the ${worker.label} worktree[\\s\\S]*DAINTREE-DONE-[a-z0-9]{6}:`)
          );
        return sendFakeAgentHandback(binDir, worker.summary, {
          paneId: worker.id,
          timeoutMs: T_LONG,
        });
      })
    );
    const sent = await sending;
    expect(sent.results, JSON.stringify(sent)).toHaveLength(2);
    workers.forEach((worker, index) => {
      const code = handbacks[index].code;
      expect(code, "the worker was asked for a handback").toMatch(/^[a-z0-9]{6}$/);
      const item = sent.results[index];
      expect(item, JSON.stringify(item)).toMatchObject({
        target: worker.id,
        ok: true,
        result: { sent: true, terminalId: worker.id },
        reply: { terminalId: worker.id, outcome: "handback", handback: worker.summary },
      });
      expect(item.reply.reply?.text ?? "").toContain(
        `DAINTREE-DONE-${code}: ${worker.summary} END-${code}`
      );
    });

    // Answered, so the held notices are gone rather than still waiting.
    await expect
      .poll(
        async () => {
          const state = await notifyState();
          return [state?.pendingCount ?? 0, state?.readyCount ?? 0];
        },
        { timeout: T_LONG }
      )
      .toEqual([0, 0]);

    const idle = await callOk(
      orchestrator,
      "terminal.waitUntilIdleBatch",
      { terminalIds: workerIds, mode: "all", timeoutMs: T_NOTICE },
      T_NOTICE + T_LONG
    );
    expect(idle, JSON.stringify(idle)).toMatchObject({ mode: "all", timedOut: false });
    expect([...idle.settledTerminalIds].sort()).toEqual([...workerIds].sort());

    // The fake writes no Claude transcript, so there is no last message to read,
    // and the call says so rather than failing.
    const lastMessage = await callOk(orchestrator, "terminal.readLastMessageOwned", {
      terminalId: workers[0].id,
    });
    expect(lastMessage, JSON.stringify(lastMessage)).toMatchObject({ status: "unavailable" });
    const unreadable = await rpc(orchestrator, "tools/call", {
      name: "terminal.readLastMessageOwned",
      arguments: { terminalId: bystanderId },
    });
    expect(unreadable?.result?.isError, JSON.stringify(unreadable)).toBe(true);
    expect(JSON.stringify(unreadable)).toContain("RESOURCE_NOT_OWNED");

    // A notice the answered wait failed to drop would be typed after these gates.
    // timer: NOTICE_DWELL_MS (notice settle + coalesce + asking-pane grace + min interval)
    await view.waitForTimeout(NOTICE_DWELL_MS);
    expect(noticesFor(binDir, orchestratorId)).toEqual(expected);
    for (const paneId of [...workerIds, bystanderId, otherLaneId, workerId]) {
      expect(noticesFor(binDir, paneId), `notice typed into ${paneId}`).toEqual([]);
    }
    expect(noticesFor(binDir, assistantId)).toHaveLength(3);

    // Cleanup reaches the orchestrator's own workers and nothing else.
    const closed = await callOk(orchestrator, "terminal.closeMany", {
      terminalIds: [workers[0].id, bystanderId],
    });
    expect(closed.results, JSON.stringify(closed)).toHaveLength(2);
    expect(closed.results[0]).toMatchObject({ target: workers[0].id, ok: true });
    expect(closed.results[1]).toMatchObject({ target: bystanderId, ok: false });
    expect(JSON.stringify(closed.results[1])).toContain("RESOURCE_NOT_OWNED");
    await callOk(orchestrator, "terminal.closeOwned", { terminalId: workers[1].id });
    const refused = await rpc(orchestrator, "tools/call", {
      name: "terminal.closeOwned",
      arguments: { terminalId: bystanderId },
    });
    expect(refused?.result?.isError, JSON.stringify(refused)).toBe(true);
    expect(JSON.stringify(refused)).toContain("RESOURCE_NOT_OWNED");

    const workerPids = workerIds.map(pidOf);
    await expect
      .poll(() => workerPids.map(isAlive), { timeout: T_LONG * 3, intervals: [250, 500, 1000] })
      .toEqual([false, false]);
    expect(isAlive(pidOf(bystanderId)), "the bystander's CLI was killed").toBe(true);
    expect(isAlive(pidOf(orchestratorId)), "the orchestrator's CLI was killed").toBe(true);
    expect(noticesFor(binDir, orchestratorId)).toEqual(expected);
  });
});

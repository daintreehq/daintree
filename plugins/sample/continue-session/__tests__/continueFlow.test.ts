import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockHost } from "../../../../shared/testing/createMockHost.js";
import type { MockHost } from "../../../../shared/testing/mockHost/types.js";
import type { ActionDispatchResult } from "../../../../shared/types/actions.js";
import type { PluginMcpCaller } from "../../../../shared/types/plugin.js";
import { activateWith } from "../main/index.js";
import { codexRollout, CODEX_SESSION_ID, tempDir, writeJsonl } from "./fixtures.js";

const PLUGIN_ID = "daintreehq.continue-session";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Scenario {
  host: MockHost;
  dataDir: string;
  sourcePath: string;
  launches: Record<string, unknown>[];
  front: { projectId: string | null; switchTo?: string; afterReads?: number; reads: number };
  sessionFile: Record<string, unknown>;
  launchResult: (args: Record<string, unknown>) => ActionDispatchResult;
  projects: string[];
}

function ok(result: unknown): ActionDispatchResult {
  return { ok: true, result } as ActionDispatchResult;
}

async function setUp(): Promise<Scenario> {
  const dir = tempDir("flow");
  dirs.push(dir);
  const sourcePath = join(dir, `rollout-2026-10-26T13-14-14-${CODEX_SESSION_ID}.jsonl`);
  writeJsonl(sourcePath, codexRollout());
  const scenario = {
    dataDir: join(dir, "data"),
    sourcePath,
    launches: [] as Record<string, unknown>[],
    front: { projectId: "p1" as string | null, reads: 0 } as Scenario["front"],
    sessionFile: {
      status: "observed",
      agentId: "codex",
      sessionId: CODEX_SESSION_ID,
      path: sourcePath,
      observedBy: "open-for-writing",
    } as Record<string, unknown>,
    launchResult: (args: Record<string, unknown>) =>
      ok({ launched: true, terminalId: args.requestedId, spawnStatus: null }),
    projects: ["p1", "p2"],
  } as Omit<Scenario, "host">;
  const host = createMockHost({
    pluginId: PLUGIN_ID,
    dispatch: async (actionId, args) => {
      const input = (args ?? {}) as Record<string, unknown>;
      switch (actionId) {
        case "project.getCurrent": {
          const front = scenario.front;
          front.reads += 1;
          if (front.switchTo && front.afterReads !== undefined && front.reads > front.afterReads) {
            front.projectId = front.switchTo;
            front.switchTo = undefined;
          }
          return ok({ project: front.projectId ? { id: front.projectId } : null });
        }
        case "project.getAll":
          return ok({ projects: scenario.projects.map((id) => ({ id })) });
        case "terminal.info.get":
          return ok({ id: input.terminalId, cwd: "/repo/wt", worktreeId: "wt-1" });
        case "terminal.sessionFile.get":
          return ok(scenario.sessionFile);
        case "agent.launch":
          scenario.launches.push(input);
          return scenario.launchResult(input);
        default:
          return {
            ok: false,
            error: { code: "NOT_FOUND", message: actionId },
          } as ActionDispatchResult;
      }
    },
  });
  let counter = 0;
  await activateWith(host, { dataDir: scenario.dataDir, newId: () => `id-${(counter += 1)}` });
  // The same object the dispatch stub reads, so a test can change what it answers.
  return Object.assign(scenario, { host }) as Scenario;
}

/** The context menu's dispatch, through the plugin's own registered action. */
async function clickContinue(host: MockHost, panelId = "pane-codex"): Promise<unknown> {
  const action = host.registeredActions.find((entry) => entry.descriptor.id === "continue");
  return action!.handler({ panelId, panelKind: "terminal", worktreeId: "wt-1" });
}

function searchTool(host: MockHost) {
  const roster = host.registeredMcpTools.find((entry) => entry.endpointId === "sessions");
  return roster!.tools.search_converted!;
}

function caller(projectId: string, terminalId: string): PluginMcpCaller {
  return { credentialId: "cred", projectId, terminalId };
}

function hashOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("Continue in another agent", () => {
  it("converts the pane's Codex session and starts Claude Code in its worktree with the hand-off", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    const before = hashOf(scenario.sourcePath);
    host.simulateConfirmResponse(true);

    const outcome = await clickContinue(host);

    expect(outcome).toEqual({
      status: "launched",
      conversionId: "id-1",
      terminalId: "continue-id-2",
    });
    expect(host.showConfirmCalls[0]?.options).toMatchObject({
      title: "Continue in Claude Code?",
      confirmLabel: "Continue in Claude Code",
    });
    expect(scenario.launches).toHaveLength(1);
    const launch = scenario.launches[0]!;
    expect(launch).toMatchObject({
      agentId: "claude",
      worktreeId: "wt-1",
      cwd: "/repo/wt",
      interactive: true,
      requestedId: "continue-id-2",
    });
    // Nothing that would raise a plugin's launch to a confirm it can't pass.
    expect(launch).not.toHaveProperty("presetId");
    expect(launch).not.toHaveProperty("agentLaunchFlags");
    expect(launch).not.toHaveProperty("systemPrompt");
    expect(launch).not.toHaveProperty("env");
    const prompt = String(launch.prompt);
    expect(prompt).toContain("Now add a test for the Linux keymap.");
    expect(prompt).toContain("Added keymap.linux.test.ts");
    expect(prompt).not.toContain("<environment_context>");

    expect(host.startedTasks[0]?.state).toBe("succeeded");
    expect(hashOf(scenario.sourcePath)).toBe(before);
  });

  it("lets only the continuing agent search the session", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    host.simulateConfirmResponse(true);
    await clickContinue(host);
    const tool = searchTool(host);
    const signal = new AbortController().signal;

    const found = (await tool.execute(
      { query: "VOICE_KEY" },
      caller("p1", "continue-id-2"),
      signal
    )) as {
      sessions: { convertedSessionId: string; sessionFile: string; hits: { line: number }[] }[];
    };
    expect(found.sessions).toHaveLength(1);
    expect(found.sessions[0]!.convertedSessionId).toBe("id-1");
    expect(found.sessions[0]!.sessionFile).toBe(scenario.sourcePath);
    expect(found.sessions[0]!.hits[0]!.line).toBeGreaterThan(0);

    await expect(
      tool.execute({ query: "VOICE_KEY" }, caller("p1", "another-pane"), signal)
    ).rejects.toThrow(/No converted session is searchable/);
    await expect(
      tool.execute({ query: "VOICE_KEY" }, caller("p2", "continue-id-2"), signal)
    ).rejects.toThrow(/No converted session is searchable/);
  });

  it("does nothing when the user declines", async () => {
    const scenario = await setUp();
    scenario.host.simulateConfirmResponse(false);
    expect(await clickContinue(scenario.host)).toEqual({ status: "declined" });
    expect(scenario.launches).toEqual([]);
    expect(scenario.host.startedTasks).toEqual([]);
  });

  it("says why when core can't name the session file, and reads nothing", async () => {
    const scenario = await setUp();
    scenario.sessionFile = { status: "unknown", reason: "session-id-unknown" };
    const outcome = (await clickContinue(scenario.host)) as { status: string };
    expect(outcome.status).toBe("unavailable");
    expect(scenario.host.showConfirmCalls).toEqual([]);
    expect(scenario.host.shownToasts[0]?.message).toContain("didn't record this pane's session");
  });

  it("refuses a file that turns out to be another session's", async () => {
    const scenario = await setUp();
    scenario.sessionFile = { ...scenario.sessionFile, sessionId: "a-different-session" };
    scenario.host.simulateConfirmResponse(true);
    const outcome = (await clickContinue(scenario.host)) as { status: string };
    expect(outcome.status).toBe("failed");
    expect(scenario.launches).toEqual([]);
    expect(scenario.host.startedTasks[0]?.result).toMatchObject({ outcome: "failed" });
  });

  it("keeps the converted session and offers a retry when the project in front changed", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    host.simulateConfirmResponse(true);
    // The project in front changes while the session converts: the click and
    // the retention check read p1, the launch check reads p2.
    scenario.front.switchTo = "p2";
    scenario.front.afterReads = 2;

    const outcome = (await clickContinue(host)) as { status: string; conversionId: string };

    expect(outcome.status).toBe("not-launched");
    expect(scenario.launches).toEqual([]);
    const notice = host.notifications[0]?.options;
    expect(notice).toMatchObject({ severity: "error", title: "Couldn't start Claude Code" });
    expect(notice?.actions?.[0]).toMatchObject({
      actionId: `${PLUGIN_ID}.launch`,
      args: { conversionId: outcome.conversionId },
    });

    // Back in the right project, the retry launches from the kept index.
    scenario.front.projectId = "p1";
    const launch = host.registeredActions.find((entry) => entry.descriptor.id === "launch");
    const retried = (await launch!.handler({ conversionId: outcome.conversionId })) as {
      status: string;
    };
    expect(retried.status).toBe("launched");
    expect(String(scenario.launches[0]!.prompt)).toContain("Now add a test for the Linux keymap.");
  });

  it("takes the search grant back when the CLI doesn't start", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    scenario.launchResult = () =>
      ok({ launched: false, terminalId: null, spawnStatus: "missing-cli" });
    host.simulateConfirmResponse(true);
    const outcome = (await clickContinue(host)) as { status: string; reason: string };
    expect(outcome).toMatchObject({ status: "not-launched" });
    expect(outcome.reason).toContain("isn't installed");
    await expect(
      searchTool(host).execute(
        { query: "voice" },
        caller("p1", String(scenario.launches[0]!.requestedId)),
        new AbortController().signal
      )
    ).rejects.toThrow(/No converted session is searchable/);
  });
});

describe("Converted sessions", () => {
  async function converted(): Promise<Scenario> {
    const scenario = await setUp();
    scenario.host.simulateConfirmResponse(true);
    await clickContinue(scenario.host);
    return scenario;
  }

  function manage(host: MockHost, projectId = "p1"): Promise<unknown> {
    const action = host.registeredActions.find((entry) => entry.descriptor.id === "manage");
    return Promise.resolve(action!.handler({ projectId }));
  }

  it("lists the project's sessions with their size", async () => {
    const { host } = await converted();
    await manage(host);
    const items = host.showQuickPickCalls[0]!.items;
    expect(items[0]).toMatchObject({ id: "id-1", label: "Codex → Claude Code" });
    expect(items[0]!.description).toMatch(/KB$/);
    expect(items.map((item) => item.id)).toEqual(["id-1", "share", "delete-all"]);
  });

  it("shares the project's sessions with every agent in it after a confirm", async () => {
    const { host } = await converted();
    host.simulateQuickPickResponse({ id: "share", label: "Share" });
    host.simulateConfirmResponse(true);
    await manage(host);
    const found = (await searchTool(host).execute(
      { query: "keymap" },
      caller("p1", "any-pane"),
      new AbortController().signal
    )) as { sessions: unknown[] };
    expect(found.sessions).toHaveLength(1);
  });

  it("deletes every converted session in the project, index files included", async () => {
    const scenario = await converted();
    const { host } = scenario;
    host.simulateQuickPickResponse({ id: "delete-all", label: "Delete" });
    host.simulateConfirmResponse(true);
    await manage(host);
    expect(readdirSync(join(scenario.dataDir, "sessions"))).toEqual([]);
    await expect(
      searchTool(host).execute(
        { query: "keymap" },
        caller("p1", "continue-id-2"),
        new AbortController().signal
      )
    ).rejects.toThrow(/No converted session is searchable/);
  });

  it("deletes a removed project's sessions, but never on a listing it can't trust", async () => {
    const scenario = await converted();
    const { host } = scenario;

    scenario.projects = [];
    await manage(host, "p2");
    expect(readdirSync(join(scenario.dataDir, "sessions"))).toEqual(["id-1.db"]);

    scenario.projects = ["p2"];
    scenario.front.projectId = "p2";
    await manage(host, "p2");
    expect(readdirSync(join(scenario.dataDir, "sessions"))).toEqual([]);
  });
});

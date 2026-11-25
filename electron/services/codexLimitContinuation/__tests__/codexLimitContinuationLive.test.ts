import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: {} as unknown,
  broadcast: vi.fn(),
  ptyClient: null as unknown as EventEmitter & {
    setCodexLimitContinue: ReturnType<typeof vi.fn>;
    getTerminalAsync: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("electron", () => ({ powerMonitor: { on: vi.fn(), off: vi.fn() } }));
vi.mock("../../../store.js", () => ({
  store: { get: (key: string) => (key === "agentSettings" ? state.settings : undefined) },
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: () => state.ptyClient }));
vi.mock("../../../ipc/utils.js", () => ({ broadcastToProjectRenderers: state.broadcast }));
vi.mock("../../ProjectStore.js", () => ({ projectStore: {} }));
vi.mock("../../codex/CodexLimitReset.js", () => ({ readCodexLimitStop: vi.fn() }));

import {
  _resetCodexLimitContinuationForTest,
  _setContinuationStoreForTest,
  decideFallback,
  noteContinuationLaunch,
  peekCodexLimitContinuation,
  prepareContinuationLaunch,
} from "../codexLimitContinuationLive.js";
import { ContinuationStore } from "../ContinuationStore.js";
import { forgetContinuationPane } from "../forgetPane.js";
import { events } from "../../events.js";

const launch = (presetId: string, launchGeneration: number) => ({
  terminalId: "t1",
  projectId: "project-1",
  launchGeneration,
  agentId: "codex",
  presetId,
  originalPresetId: presetId,
});

describe("codexLimitContinuationLive — launches a preset arms (#17912)", () => {
  beforeEach(() => {
    _setContinuationStoreForTest(new ContinuationStore(null));
    state.ptyClient = Object.assign(new EventEmitter(), {
      setCodexLimitContinue: vi.fn(),
      getTerminalAsync: vi.fn(async () => null),
    });
    state.settings = {
      agents: {
        codex: {
          customPresets: [
            { id: "on", name: "On", continueAtLimitReset: true },
            { id: "off", name: "Off" },
          ],
        },
      },
    };
  });

  afterEach(() => {
    _resetCodexLimitContinuationForTest();
  });

  it("creates nothing for a launch its preset doesn't arm", () => {
    noteContinuationLaunch(launch("off", 1));
    expect(peekCodexLimitContinuation()).toBeNull();
  });

  it("arms a pane its own preset arms once the host confirms the spawn", () => {
    noteContinuationLaunch(launch("on", 1));
    state.ptyClient.emit("spawn-result", "t1", {
      success: true,
      id: "t1",
      launchGeneration: 1,
      spawnedAt: 5,
    });
    expect(peekCodexLimitContinuation()?.isArmed("t1")).toBe(true);
    expect(state.ptyClient.setCodexLimitContinue).toHaveBeenCalledWith("t1", true, undefined);
  });

  it("arms a pane its menu armed before a cold restart, whatever its preset says (#18193)", async () => {
    const saved = JSON.stringify({
      version: 1,
      panes: [{ projectId: "project-1", terminalId: "t1", override: true }],
    });
    _setContinuationStoreForTest(
      new ContinuationStore({ read: async () => saved, write: async () => {} })
    );
    await prepareContinuationLaunch();
    noteContinuationLaunch(launch("off", 1));
    state.ptyClient.emit("spawn-result", "t1", {
      success: true,
      id: "t1",
      launchGeneration: 1,
      spawnedAt: 5,
    });
    expect(peekCodexLimitContinuation()?.isArmed("t1")).toBe(true);
  });

  it("takes up a stop saved before a cold restart on the restore's launch (#18193)", async () => {
    const saved = JSON.stringify({
      version: 1,
      panes: [
        {
          projectId: "project-1",
          terminalId: "t1",
          stop: { agentId: "codex", resetsAt: 9_000_000, identity: "digest", savedAt: 1 },
        },
      ],
    });
    _setContinuationStoreForTest(
      new ContinuationStore({ read: async () => saved, write: async () => {} })
    );
    await prepareContinuationLaunch();
    // The preset arms the pane; the restore resumes the conversation the stop was in.
    noteContinuationLaunch({
      ...launch("on", 1),
      restore: { agentId: "codex", sessionId: "s1", startsFresh: false },
    });
    state.ptyClient.emit("spawn-result", "t1", {
      success: true,
      id: "t1",
      launchGeneration: 1,
      spawnedAt: 5,
    });
    expect(peekCodexLimitContinuation()?.list("project-1")[0]?.state).toMatchObject({
      status: "waiting",
      resetsAt: 9_000_000,
    });
    expect(state.ptyClient.setCodexLimitContinue).toHaveBeenLastCalledWith("t1", true, "digest");
  });

  const savedWait = JSON.stringify({
    version: 1,
    panes: [
      {
        projectId: "project-1",
        terminalId: "t1",
        stop: { agentId: "codex", sessionId: "s1", resetsAt: 9_000_000, identity: "d", savedAt: 1 },
      },
    ],
  });

  it("restores a pane that was waiting as Daintree quit armed, though its preset no longer arms it (#18193)", async () => {
    _setContinuationStoreForTest(
      new ContinuationStore({ read: async () => savedWait, write: async () => {} })
    );
    await prepareContinuationLaunch();
    noteContinuationLaunch({
      ...launch("off", 1),
      restore: { agentId: "codex", sessionId: "s1", startsFresh: false },
    });
    state.ptyClient.emit("spawn-result", "t1", { success: true, id: "t1", launchGeneration: 1 });
    expect(peekCodexLimitContinuation()?.list("project-1")[0]?.state).toMatchObject({
      status: "waiting",
    });
  });

  it("lets the saved wait go when the pane's first launch isn't its restore (#18193)", async () => {
    const writes: string[] = [];
    const saved = new ContinuationStore({
      read: async () => savedWait,
      write: async (data) => void writes.push(data),
    });
    _setContinuationStoreForTest(saved);
    await prepareContinuationLaunch();
    noteContinuationLaunch(launch("off", 1));
    state.ptyClient.emit("spawn-result", "t1", { success: true, id: "t1", launchGeneration: 1 });
    expect(peekCodexLimitContinuation()?.isArmed("t1")).toBe(false);
    await saved.close();
    expect(JSON.parse(writes.at(-1)!).panes).toEqual([]);
  });

  it("notes a newer launch its preset doesn't arm while an older one awaits its spawn", () => {
    // Both queued before the shard was ready; only the newer is sent.
    noteContinuationLaunch(launch("on", 1));
    noteContinuationLaunch(launch("off", 2));
    state.ptyClient.emit("spawn-result", "t1", {
      success: true,
      id: "t1",
      launchGeneration: 2,
      spawnedAt: 5,
    });
    expect(peekCodexLimitContinuation()?.isArmed("t1")).toBe(false);
  });

  it("forgets a pane closed for good, by kill or by the trash letting it go", () => {
    noteContinuationLaunch(launch("on", 1));
    state.ptyClient.emit("spawn-result", "t1", { success: true, id: "t1", launchGeneration: 1 });
    forgetContinuationPane("t1");
    expect(peekCodexLimitContinuation()?.isArmed("t1")).toBe(false);

    noteContinuationLaunch(launch("on", 2));
    state.ptyClient.emit("spawn-result", "t1", { success: true, id: "t1", launchGeneration: 2 });
    expect(peekCodexLimitContinuation()?.isArmed("t1")).toBe(true);
    events.emit("terminal:trash-cleared", { id: "t1", expiresAt: 0 });
    expect(peekCodexLimitContinuation()?.isArmed("t1")).toBe(false);
  });
});

describe("codexLimitContinuationLive — whose preset decides a fallback (#18192)", () => {
  const pane = (detectedAgentId: string | undefined) => ({
    projectId: undefined,
    launchAgentId: "codex",
    detectedAgentId,
    agentPresetId: "home",
    originalAgentPresetId: "home",
    fallbackChainIndex: 0,
    isAssistantTerminal: false,
    spawnedAt: 1_000,
    launchGeneration: undefined,
    agentSessionId: undefined,
  });

  beforeEach(() => {
    state.settings = {
      agents: {
        codex: {
          customPresets: [
            { id: "home", name: "Home", fallbackOnRateLimit: true, fallbacks: ["work"] },
            { id: "work", name: "Work" },
          ],
        },
      },
    };
  });

  it("reads the launch's preset for the agent it launched", async () => {
    // Its project's presets can't be read here, so the chain can't be placed.
    expect(await decideFallback(pane("codex"))).toBe("unknown");
  });

  it("never lets the launch's preset decide for another agent run in the pane", async () => {
    expect(await decideFallback(pane("claude"))).toBe("none");
  });
});

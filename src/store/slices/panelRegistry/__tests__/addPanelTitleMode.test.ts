/**
 * Tests that addPanel propagates a caller-supplied `titleMode` onto the created
 * PTY panel (issue #10439).
 *
 * `titleMode: "custom"` is how an assistant-named agent launch pins its title so
 * the identity reducer's agent-detected/exited rewrites skip it. The field was
 * previously dropped on the floor between AddPanelOptions and the panel object.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  globalEnvClient: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    prewarmTerminal: vi.fn(),
    setInputLocked: vi.fn(),
    sendPtyResize: vi.fn(),
    waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
    // No attached renderer xterm in these tests — spawn falls back to the
    // default/estimated dims path.
    get: vi.fn(() => null),
  },
}));

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return {
    ...actual,
    saveNormalized: vi.fn(),
  };
});

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    electron: {
      globalEnv: {
        get: vi.fn().mockResolvedValue({}),
      },
    },
  };
});

const { usePanelStore } = await import("../../../panelStore");

function getPtyPanel(id: string): PtyPanelData | undefined {
  return usePanelStore.getState().panelsById[id] as PtyPanelData | undefined;
}

describe("addPanel titleMode propagation (#10439)", () => {
  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();

    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    terminalClient.spawn.mockReset();
    terminalClient.spawn.mockImplementation(async ({ id }: { id?: string }) => id ?? "spawn-id");
  });

  it("stamps titleMode 'custom' and the supplied title onto the panel", async () => {
    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      title: "Claude: auth refactor",
      titleMode: "custom",
      requestedId: "named-1",
      cwd: "/",
      bypassLimits: true,
    });

    expect(id).toBe("named-1");
    const panel = getPtyPanel("named-1");
    expect(panel?.title).toBe("Claude: auth refactor");
    expect(panel?.titleMode).toBe("custom");
  });

  it("leaves titleMode unset when the caller does not supply one", async () => {
    const { addPanel } = usePanelStore.getState();
    const id = await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "default-1",
      cwd: "/",
      bypassLimits: true,
    });

    expect(id).toBe("default-1");
    const panel = getPtyPanel("default-1");
    expect(panel?.titleMode).toBeUndefined();
  });
});

describe("addPanel actionContext propagation (#10647)", () => {
  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();

    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    terminalClient.spawn.mockReset();
    terminalClient.spawn.mockImplementation(async ({ id }: { id?: string }) => id ?? "spawn-id");
  });

  it("threads a caller-supplied launch ActionContext through to terminal.spawn", async () => {
    const { addPanel } = usePanelStore.getState();
    const launchContext = {
      projectId: "p1",
      activeWorktreeId: "wt-7",
      focusedTerminalId: "term-3",
    };

    await addPanel({
      kind: "terminal",
      launchAgentId: "daintree-assistant",
      command: "daintree-assistant",
      requestedId: "assistant-1",
      cwd: "/",
      bypassLimits: true,
      actionContext: launchContext,
    });

    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    expect(terminalClient.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ actionContext: launchContext })
    );
  });

  it("passes actionContext undefined when the caller supplies none", async () => {
    const { addPanel } = usePanelStore.getState();

    await addPanel({
      kind: "terminal",
      launchAgentId: "daintree-assistant",
      command: "daintree-assistant",
      requestedId: "assistant-2",
      cwd: "/",
      bypassLimits: true,
    });

    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    const spawnArg = terminalClient.spawn.mock.calls[0]![0] as { actionContext?: unknown };
    expect(spawnArg.actionContext).toBeUndefined();
  });
});

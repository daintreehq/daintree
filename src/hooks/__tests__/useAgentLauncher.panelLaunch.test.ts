// @vitest-environment jsdom
/**
 * A browser or dev-preview launch takes the caller's options the terminal
 * branch takes (#17221): focus policy, requested id, name, persistence and
 * exit handling. Only `launchedByPluginId` stays off, as it does for a plain
 * shell: it lets a plugin hold an agent's pane on restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { runWithMcpSpawnFocusSuppressed } from "@/store/mcpSpawnFocusGuard";

const addPanel = vi.fn<(options: Record<string, unknown>, commit?: unknown) => Promise<string>>();

vi.mock("@/store/panelStore", () => {
  const state = {
    addPanel: (options: Record<string, unknown>, commit?: unknown) => addPanel(options, commit),
    panelsById: {},
  };
  const usePanelStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state,
  });
  return { usePanelStore };
});

vi.mock("../useWorktreeStore", () => ({
  useWorktreeStoreApi: () => ({
    getState: () => ({ worktrees: new Map(), isInitialized: false }),
  }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: unknown) => unknown) =>
    selector({ activeWorktreeId: null, deletedWorktrees: new Set() }),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) =>
    selector({ currentProject: { path: "/repo" } }),
}));

vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (selector: (s: unknown) => unknown) => selector({ currentScratch: null }),
}));

vi.mock("@/hooks/app/useHomeDir", () => ({ useHomeDir: () => ({ homeDir: "/home/u" }) }));

vi.mock("@/store/cliAvailabilityStore", () => {
  const state = {
    availability: {},
    details: {},
    isLoading: false,
    isRefreshing: false,
    initialize: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  return {
    useCliAvailabilityStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state }
    ),
  };
});

vi.mock("@/store/agentSettingsStore", () => {
  const state = {
    settings: null,
    initialize: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  return {
    useAgentSettingsStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state }
    ),
  };
});

vi.mock("@/clients", () => ({
  systemClient: { onWake: vi.fn(() => () => {}) },
  terminalClient: { getHostAgentLimit: vi.fn() },
}));

const readViewDevServerCommand = vi.hoisted(() => vi.fn());
vi.mock("@/utils/devServerCommand", () => ({
  readViewDevServerCommand: () => readViewDevServerCommand(),
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

const { useAgentLauncher } = await import("../useAgentLauncher");

type LaunchOptions = Parameters<ReturnType<typeof useAgentLauncher>["launchAgent"]>[1];

async function launch(kind: string, options?: LaunchOptions): Promise<Record<string, unknown>> {
  const { result } = renderHook(() => useAgentLauncher());
  await act(async () => {
    await result.current.launchAgent(kind, options);
  });
  expect(addPanel).toHaveBeenCalledOnce();
  const added = addPanel.mock.calls[0]?.[0];
  if (!added) throw new Error("addPanel was not called");
  return added;
}

describe.each([
  { kind: "browser", namesItself: false },
  { kind: "dev-preview", namesItself: true },
] as const)(
  "useAgentLauncher — a $kind launch keeps the caller's options (#17221)",
  ({ kind, namesItself }) => {
    beforeEach(() => {
      addPanel.mockReset();
      addPanel.mockResolvedValue(`${kind}-1`);
      readViewDevServerCommand.mockReset();
      readViewDevServerCommand.mockResolvedValue(undefined);
      Reflect.set(window, "electron", {});
    });

    afterEach(() => {
      Reflect.set(window, "electron", undefined);
    });

    it("keeps focus where it is when asked to", async () => {
      const options = await launch(kind, { focusPolicy: "preserve" });

      expect(options).toMatchObject({ kind, focusPolicy: "preserve" });
    });

    it("keeps focus where it is inside an MCP dispatch that named no policy", async () => {
      const { result } = renderHook(() => useAgentLauncher());
      await act(async () => {
        await runWithMcpSpawnFocusSuppressed(() => result.current.launchAgent(kind));
      });

      expect(addPanel.mock.calls[0]?.[0]).toMatchObject({ kind, focusPolicy: "preserve" });
    });

    it("lets an explicit policy outrank the MCP dispatch's", async () => {
      const { result } = renderHook(() => useAgentLauncher());
      await act(async () => {
        await runWithMcpSpawnFocusSuppressed(() =>
          result.current.launchAgent(kind, { focusPolicy: "take" })
        );
      });

      expect(addPanel.mock.calls[0]?.[0]).toMatchObject({ kind, focusPolicy: "take" });
    });

    it("leaves the policy to the panel store outside an MCP dispatch", async () => {
      const options = await launch(kind);

      expect(options.focusPolicy).toBeUndefined();
    });

    it("creates the panel under the requested id", async () => {
      const options = await launch(kind, { requestedId: `${kind}-requested` });

      expect(options).toMatchObject({ kind, requestedId: `${kind}-requested` });
    });

    it("titles the panel with the caller's name, pinned against derived rewrites", async () => {
      const options = await launch(kind, { name: "  Staging\n  checkout  " });

      expect(options).toMatchObject({ kind, title: "Staging checkout", titleMode: "custom" });
    });

    it("keeps the default title for a name with nothing printable in it", async () => {
      const options = await launch(kind, { name: " \t\n " });
      addPanel.mockClear();
      const defaults = await launch(kind);

      // A browser leaves its title to the panel store; a dev preview names itself.
      if (namesItself) {
        expect(defaults.title).toEqual(expect.stringMatching(/\S/));
      } else {
        expect(defaults).not.toHaveProperty("title");
      }
      expect(options.title).toBe(defaults.title);
      expect(options).not.toHaveProperty("titleMode");
    });

    it.each([
      [{ excludeFromPersistence: true }, { excludeFromPersistence: true, removeOnExit: undefined }],
      [{ removeOnExit: true }, { excludeFromPersistence: undefined, removeOnExit: true }],
      [{ excludeFromPersistence: false }, { excludeFromPersistence: false }],
    ])("carries persistence and exit handling to the panel: %o", async (given, expected) => {
      const options = await launch(kind, given);

      expect(options).toMatchObject({ kind, ...expected });
    });

    it.each(["assistant", "mcp", undefined] as const)(
      "carries the spawn source %s to the panel",
      async (spawnedBy) => {
        const options = await launch(kind, { spawnedBy });

        expect(options.spawnedBy).toBe(spawnedBy);
      }
    );

    it("leaves the panel unowned by the launching plugin, like a plain shell", async () => {
      const options = await launch(kind, { launchedByPluginId: "acme.orchestrator" });

      expect(options).not.toHaveProperty("launchedByPluginId");
    });
  }
);

describe("useAgentLauncher — a dev-preview launch keeps its own fields under caller options", () => {
  beforeEach(() => {
    addPanel.mockReset();
    addPanel.mockResolvedValue("dev-preview-1");
    readViewDevServerCommand.mockReset();
    readViewDevServerCommand.mockResolvedValue("pnpm dev --port 4123");
    Reflect.set(window, "electron", {});
  });

  afterEach(() => {
    Reflect.set(window, "electron", undefined);
  });

  it("still carries the project's dev-server command beside a custom name", async () => {
    const options = await launch("dev-preview", { name: "API preview", focusPolicy: "preserve" });

    expect(readViewDevServerCommand).toHaveBeenCalledOnce();
    expect(options).toMatchObject({
      kind: "dev-preview",
      devCommand: "pnpm dev --port 4123",
      title: "API preview",
      focusPolicy: "preserve",
    });
  });
});

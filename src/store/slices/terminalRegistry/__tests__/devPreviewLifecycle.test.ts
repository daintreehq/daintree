import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TabGroup } from "@/types";

const mockStopByPanel = vi.fn().mockResolvedValue(undefined);

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
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("../../../persistence/terminalPersistence", () => ({
  terminalPersistence: {
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { useTerminalStore } = await import("../../../terminalStore");

describe("dev-preview lifecycle integration", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      electron: {
        devPreview: {
          stopByPanel: mockStopByPanel,
        },
      },
    });

    const { reset } = useTerminalStore.getState();
    await reset();
    useTerminalStore.setState({
      terminals: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
      activeTabByGroup: new Map(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("stops dev-preview runtime when panel is removed", () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: "dev-panel-1",
          kind: "dev-preview",
          type: "terminal",
          title: "Dev Preview",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          location: "grid",
          devCommand: "npm run dev",
        },
      ],
    });

    useTerminalStore.getState().removeTerminal("dev-panel-1");

    expect(mockStopByPanel).toHaveBeenCalledWith({ panelId: "dev-panel-1" });
  });

  it("stops dev-preview runtime when panel is trashed", () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: "dev-panel-2",
          kind: "dev-preview",
          type: "terminal",
          title: "Dev Preview",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          location: "grid",
          devCommand: "npm run dev",
        },
      ],
    });

    useTerminalStore.getState().trashTerminal("dev-panel-2");

    expect(mockStopByPanel).toHaveBeenCalledWith({ panelId: "dev-panel-2" });
  });

  it("stops dev-preview runtimes when trashing a panel group", () => {
    const group: TabGroup = {
      id: "group-dev-preview",
      panelIds: ["dev-panel-3", "term-1"],
      activeTabId: "dev-panel-3",
      location: "grid",
    };

    useTerminalStore.setState({
      terminals: [
        {
          id: "dev-panel-3",
          kind: "dev-preview",
          type: "terminal",
          title: "Dev Preview",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          location: "grid",
          devCommand: "npm run dev",
        },
        {
          id: "term-1",
          kind: "terminal",
          type: "terminal",
          title: "Terminal",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
      tabGroups: new Map([["group-dev-preview", group]]),
    });

    useTerminalStore.getState().trashPanelGroup("dev-panel-3");

    expect(mockStopByPanel).toHaveBeenCalledWith({ panelId: "dev-panel-3" });
    expect(mockStopByPanel).toHaveBeenCalledTimes(1);
  });
});

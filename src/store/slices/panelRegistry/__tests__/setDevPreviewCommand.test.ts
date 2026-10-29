import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PanelInstance, DevPreviewPanelData } from "@shared/types/panel";

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

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

const saveMock = vi.fn();

vi.mock("../../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: saveMock,
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { usePanelStore } = await import("../../../panelStore");

describe("setDevPreviewCommand", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      electron: {},
    });

    const { reset } = usePanelStore.getState();
    await reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const devPreview = (devCommand?: string) =>
    ({
      id: "dev-1",
      kind: "dev-preview",
      title: "Dev",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      location: "grid",
      ...(devCommand !== undefined && { devCommand }),
    }) as PanelInstance;

  const storedCommand = () =>
    (usePanelStore.getState().panelsById["dev-1"] as DevPreviewPanelData | undefined)?.devCommand;

  it("replaces a preview's own command, trimmed, and persists it", () => {
    const before = devPreview("npm run dev");
    usePanelStore.setState({ panelsById: { "dev-1": before }, panelIds: ["dev-1"] });

    usePanelStore.getState().setDevPreviewCommand("dev-1", "  npm run dev:web ");

    expect(storedCommand()).toBe("npm run dev:web");
    // A new panel object, so selectors on it see the change.
    expect(usePanelStore.getState().panelsById["dev-1"]).not.toBe(before);
    const saved = saveMock.mock.lastCall?.[0] as DevPreviewPanelData[] | undefined;
    expect(saved?.find((p) => p.id === "dev-1")?.devCommand).toBe("npm run dev:web");
  });

  it("gives an inheriting preview a command of its own", () => {
    usePanelStore.setState({ panelsById: { "dev-1": devPreview() }, panelIds: ["dev-1"] });

    usePanelStore.getState().setDevPreviewCommand("dev-1", "npm run dev:web");

    expect(storedCommand()).toBe("npm run dev:web");
  });

  it("skips persistence when the command is unchanged", () => {
    usePanelStore.setState({
      panelsById: { "dev-1": devPreview("npm run dev") },
      panelIds: ["dev-1"],
    });

    usePanelStore.getState().setDevPreviewCommand("dev-1", " npm run dev");

    expect(saveMock).not.toHaveBeenCalled();
  });

  it("compares against the stored command trimmed", () => {
    usePanelStore.setState({
      panelsById: { "dev-1": devPreview("  npm run dev  ") },
      panelIds: ["dev-1"],
    });

    usePanelStore.getState().setDevPreviewCommand("dev-1", "npm run dev");

    expect(saveMock).not.toHaveBeenCalled();
  });

  it("ignores a blank command rather than clearing the preview's own one", () => {
    usePanelStore.setState({
      panelsById: { "dev-1": devPreview("npm run dev") },
      panelIds: ["dev-1"],
    });

    usePanelStore.getState().setDevPreviewCommand("dev-1", "   ");

    expect(storedCommand()).toBe("npm run dev");
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("is a no-op for non-dev-preview kinds", () => {
    usePanelStore.setState({
      panelsById: {
        "browser-1": { id: "browser-1", kind: "browser", title: "Browser", location: "grid" },
      },
      panelIds: ["browser-1"],
    });

    usePanelStore.getState().setDevPreviewCommand("browser-1", "npm run dev");

    const stored = usePanelStore.getState().panelsById["browser-1"] as
      Record<string, unknown> | undefined;
    expect(stored?.devCommand).toBeUndefined();
    expect(saveMock).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
/**
 * "Find session" action on the lost-session banner (issue #12182). Uses the
 * real store (matching `useSessionLostBanner.test.tsx`'s harness) with
 * `addPanel` swapped for a spy — everything else about panel state stays
 * real, only the heavy IPC-backed action is replaced. Radix renders
 * synchronously via `vitest.setup.ts`'s global priming, so no popover mock
 * is needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import type { CodexFolderSession } from "@shared/types/ipc/agentSubagents";

const findSessions = vi.hoisted(() => vi.fn());

vi.mock("@/clients/codexClient", () => ({
  codexClient: { findSessions },
}));

// Deterministic in place of the real agent-config lookup, matching the
// pattern `statePatcher.test.ts` uses for the same function.
vi.mock("@shared/types", async () => {
  const actual = await vi.importActual<typeof import("@shared/types")>("@shared/types");
  return {
    ...actual,
    buildResumeCommand: (agentId: string, sessionId: string) => `${agentId} resume ${sessionId}`,
  };
});

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
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
  systemClient: { getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("../../../store/slices/panelRegistry/persistence", async () => {
  const actual = await vi.importActual<
    typeof import("../../../store/slices/panelRegistry/persistence")
  >("../../../store/slices/panelRegistry/persistence");
  return { ...actual, saveNormalized: vi.fn() };
});

const { usePanelStore } = await import("@/store/panelStore");
const { FindCodexSessionAction } = await import("../FindCodexSessionAction");
const { _resetSelectorCacheForTests } = await import("@/store/slices/panelRegistry/selectors");

const addPanel = vi.fn().mockResolvedValue("new-pane-id");

function panel(id: string, overrides: Partial<PtyPanelData> = {}): PanelInstance {
  return {
    id,
    kind: "terminal",
    title: id,
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "grid",
    launchAgentId: "codex",
    ...overrides,
  } as PanelInstance;
}

function seed(...panels: PanelInstance[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    addPanel,
  });
}

function ok(sessions: CodexFolderSession[]) {
  return { status: "ok" as const, sessions };
}

beforeEach(() => {
  _resetSelectorCacheForTests();
  findSessions.mockReset();
  addPanel.mockClear();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FindCodexSessionAction", () => {
  it("renders nothing for a pane not running Codex", () => {
    seed(panel("t-1", { launchAgentId: "gemini" }));
    render(<FindCodexSessionAction panelId="t-1" />);
    expect(screen.queryByRole("button", { name: "Find session" })).toBeNull();
  });

  it("renders nothing for an unknown panel id", () => {
    render(<FindCodexSessionAction panelId="missing" />);
    expect(screen.queryByRole("button", { name: "Find session" })).toBeNull();
  });

  it("renders the trigger for a Codex pane and fetches on open", async () => {
    findSessions.mockResolvedValue(
      ok([{ id: "sess-1", preview: "fix the flaky test", updatedAt: 1_700_000_000_000 }])
    );
    seed(panel("t-1"));

    render(<FindCodexSessionAction panelId="t-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Find session" }));

    expect(await screen.findByText("fix the flaky test")).toBeTruthy();
    expect(findSessions).toHaveBeenCalledWith({ cwd: "/repo", codexHome: undefined });
  });

  it("passes the pane's own CODEX_HOME, not main's default profile", async () => {
    findSessions.mockResolvedValue(ok([]));
    seed(panel("t-1", { env: { CODEX_HOME: "/pane/.codex" } }));

    render(<FindCodexSessionAction panelId="t-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Find session" }));

    await waitFor(() =>
      expect(findSessions).toHaveBeenCalledWith({ cwd: "/repo", codexHome: "/pane/.codex" })
    );
  });

  it("shows an empty state when the folder has no sessions", async () => {
    findSessions.mockResolvedValue(ok([]));
    seed(panel("t-1"));

    render(<FindCodexSessionAction panelId="t-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Find session" }));

    expect(await screen.findByText("No other sessions found here")).toBeTruthy();
  });

  it("shows an error state when Codex can't be reached", async () => {
    findSessions.mockResolvedValue({ status: "unavailable", reason: "cli-missing" });
    seed(panel("t-1"));

    render(<FindCodexSessionAction panelId="t-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Find session" }));

    expect(await screen.findByText("Codex CLI isn't available")).toBeTruthy();
  });

  it("excludes a session a sibling pane already has open (#11461)", async () => {
    findSessions.mockResolvedValue(
      ok([
        { id: "held-by-sibling", preview: "already open elsewhere", updatedAt: 2 },
        { id: "still-findable", preview: "not open anywhere", updatedAt: 1 },
      ])
    );
    seed(
      panel("t-1"),
      panel("t-2", { agentSessionId: "held-by-sibling" }),
      panel("t-3", { agentSessionId: "unrelated", launchAgentId: "claude" })
    );

    render(<FindCodexSessionAction panelId="t-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Find session" }));

    expect(await screen.findByText("not open anywhere")).toBeTruthy();
    expect(screen.queryByText("already open elsewhere")).toBeNull();
  });

  it("opens the chosen session in a new pane and closes the picker", async () => {
    findSessions.mockResolvedValue(ok([{ id: "sess-1", preview: "pick me", updatedAt: 1 }]));
    seed(panel("t-1", { agentLaunchFlags: ["--yolo"] }));

    render(<FindCodexSessionAction panelId="t-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Find session" }));
    fireEvent.click(await screen.findByText("pick me"));

    await waitFor(() => expect(addPanel).toHaveBeenCalledOnce());
    const call = addPanel.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      kind: "terminal",
      cwd: "/repo",
      launchAgentId: "codex",
      agentSessionId: "sess-1",
    });
    expect(typeof call.command).toBe("string");
    expect(call.command).toContain("sess-1");
    // Picking a session closes the popover — its content leaves the document.
    await waitFor(() => expect(screen.queryByText("pick me")).toBeNull());
  });
});

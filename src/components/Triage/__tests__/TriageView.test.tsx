// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { TriageSnapshot } from "@shared/types/ipc/triage";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
});

afterAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: originalScrollIntoView,
    configurable: true,
  });
});

const dispatchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));

import { TriageView } from "../TriageView";
import { useTriageStore } from "@/store/triageStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";

const NOW = Date.now();

function run(runId: string, overrides: Partial<FleetSnapshot["runs"][number]> = {}) {
  return {
    runId,
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/repo",
    agentId: "claude" as const,
    ...overrides,
  };
}

const triageSnapshot: TriageSnapshot = {
  configured: true,
  missingKeys: [],
  active: true,
  busy: false,
  refreshedAt: NOW,
  describerModel: "gpt-oss-120b",
  cards: [],
  lastError: null,
};

function installElectron() {
  const triage = {
    onSnapshotUpdated: vi.fn(() => () => {}),
    setActive: vi.fn(async () => triageSnapshot),
    refresh: vi.fn(async () => {}),
    choose: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    trash: vi.fn(async () => {}),
  };
  Object.defineProperty(window, "electron", {
    value: { triage, terminal: { restore: vi.fn() } },
    configurable: true,
    writable: true,
  });
  return triage;
}

/** Drain the landing effect's two animation frames. */
async function frames() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

beforeEach(() => {
  useProjectStore.setState({
    projects: [{ id: "p1", path: "/repo", name: "app", emoji: "🌳", lastOpened: NOW }],
  });
  useFleetSnapshotStore.setState({
    snapshot: {
      runs: [
        run("waiting", { agentState: "waiting", waitingReason: "approval", since: NOW - 60_000 }),
        run("working", { agentState: "working", since: NOW - 30_000 }),
      ],
      changedAt: NOW,
      degraded: false,
      lastSuccessfulAt: NOW,
    },
  });
  useTriageStore.setState({ isOpen: true, snapshot: triageSnapshot });
});

afterEach(() => {
  useTriageStore.setState({ isOpen: false, snapshot: null });
  vi.clearAllMocks();
});

function cards(container: HTMLElement) {
  return [...container.ownerDocument.querySelectorAll<HTMLElement>("[data-triage-card]")];
}

describe("TriageView", () => {
  it("lands on the most urgent card and moves between cards with the arrows", async () => {
    installElectron();
    const { container } = render(<TriageView />);
    await frames();
    const [first, second] = cards(container);
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
  });

  it("tells main the panel is open, and closed again on unmount", async () => {
    const triage = installElectron();
    const { unmount } = render(<TriageView />);
    expect(triage.setActive).toHaveBeenCalledWith(true);
    unmount();
    expect(triage.setActive).toHaveBeenLastCalledWith(false);
  });

  it("goes to a terminal in this project before closing, and stays open if that fails", async () => {
    installElectron();
    (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__ = {
      id: "p1",
    };
    dispatchMock.mockResolvedValueOnce({ ok: false });
    const { container } = render(<TriageView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "Enter" });
    expect(dispatchMock).toHaveBeenCalledWith(
      "pilot.openRun",
      { runId: "waiting", workspaceId: "p1" },
      { source: "user" }
    );
    await act(async () => {});
    expect(useTriageStore.getState().isOpen).toBe(true);
    delete (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__;
  });
});

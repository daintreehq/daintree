// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type {
  AgentUsageReadout,
  AgentUsageSnapshot,
  AgentUsageTrackingSnapshot,
} from "@shared/types/ipc/agentUsage";

const { view } = vi.hoisted(() => ({
  view: { observable: true, listeners: new Set<(observable: boolean) => void>() },
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewObservable: () => view.observable,
  subscribeProjectViewObservability: (listener: (observable: boolean) => void) => {
    view.listeners.add(listener);
    return () => view.listeners.delete(listener);
  },
}));
vi.mock("@/components/Project/ProjectResourceBadge", () => ({ ProjectResourceBadge: () => null }));
vi.mock("@/store/keepAwakeStore", () => ({
  useKeepAwakeStore: (select: (state: { visible: boolean }) => unknown) =>
    select({ visible: false }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  initAgentUsageTrackingSync,
  useAgentUsageTrackingStore,
} from "@/store/agentUsageTrackingStore";
import { setAgentUsageExpanded } from "../agentUsageExpanded";
import { SidebarStatusBar } from "../SidebarStatusBar";

function codex(usedPercent: number): AgentUsageReadout {
  return {
    hostId: "local",
    hostName: null,
    reading: {
      agentId: "codex",
      accountNames: ["Work"],
      isDefault: false,
      windowDurationMins: 300,
      usedPercent,
      resetsAt: null,
      observedAt: Date.now(),
    },
  };
}

const bridge = {
  readouts: [] as AgentUsageReadout[],
  revision: 0,
  pushTracking: null as ((snapshot: AgentUsageTrackingSnapshot) => void) | null,
  getTracking: vi.fn<() => Promise<AgentUsageTrackingSnapshot>>(),
  setFollowing: vi.fn<(payload: { following: boolean }) => Promise<AgentUsageSnapshot | null>>(),
};

function installBridge(tracking: AgentUsageTrackingSnapshot | Promise<AgentUsageTrackingSnapshot>) {
  bridge.getTracking.mockImplementation(() => Promise.resolve(tracking));
  bridge.setFollowing.mockImplementation(async ({ following }) =>
    following ? { readouts: bridge.readouts, revision: ++bridge.revision } : null
  );
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      agentUsage: {
        setFollowing: bridge.setFollowing,
        getTracking: bridge.getTracking,
        onChanged: () => () => {},
        onTrackingChanged: (callback: (snapshot: AgentUsageTrackingSnapshot) => void) => {
          bridge.pushTracking = callback;
          return () => (bridge.pushTracking = null);
        },
      },
    },
  });
}

let stopSync: (() => void) | null = null;

async function renderBar() {
  stopSync = initAgentUsageTrackingSync();
  const rendered = render(
    <TooltipProvider>
      <SidebarStatusBar />
    </TooltipProvider>
  );
  await act(async () => {});
  return rendered;
}

async function pushTracking(snapshot: AgentUsageTrackingSnapshot) {
  await act(async () => {
    bridge.pushTracking?.(snapshot);
  });
}

function section(container: HTMLElement) {
  return container.querySelector("[data-sidebar-agent-usage]");
}

function rowTexts(container: HTMLElement) {
  return [...container.querySelectorAll("[data-sidebar-agent-usage-row]")].map(
    (row) => row.textContent
  );
}

function followCalls() {
  return bridge.setFollowing.mock.calls.map(([payload]) => payload.following);
}

describe("SidebarStatusBar with agent usage tracking (#17981)", () => {
  beforeEach(() => {
    bridge.readouts = [codex(40)];
    bridge.revision = 0;
    bridge.getTracking.mockReset();
    bridge.setFollowing.mockReset();
    view.observable = true;
    view.listeners.clear();
    setAgentUsageExpanded(true);
    useAgentUsageTrackingStore.setState({ enabled: null, revision: -1 });
  });

  afterEach(() => {
    stopSync?.();
    stopSync = null;
    cleanup();
    Reflect.deleteProperty(window, "electron");
  });

  it("shows no Usage section and asks for no readings while tracking is off", async () => {
    installBridge({ enabled: false, revision: 0 });
    const { container } = await renderBar();
    expect(section(container)).toBeNull();
    // Even a view that becomes observable again asks for nothing.
    view.observable = false;
    act(() => {
      for (const listener of [...view.listeners]) listener(false);
    });
    view.observable = true;
    act(() => {
      for (const listener of [...view.listeners]) listener(true);
    });
    await act(async () => {});
    expect(followCalls()).toEqual([]);
  });

  it("asks for nothing until main says whether tracking is on", async () => {
    installBridge(new Promise<AgentUsageTrackingSnapshot>(() => {}));
    const { container } = await renderBar();
    expect(section(container)).toBeNull();
    expect(followCalls()).toEqual([]);
  });

  it("takes the section away when turned off, and brings it back with fresh readings when turned on", async () => {
    installBridge({ enabled: true, revision: 0 });
    const { container } = await renderBar();
    expect(rowTexts(container)).toEqual(["40%"]);
    expect(followCalls()).toEqual([true]);

    await pushTracking({ enabled: false, revision: 1 });
    expect(section(container)).toBeNull();
    expect(followCalls()).toEqual([true, false]);

    bridge.readouts = [codex(55)];
    await pushTracking({ enabled: true, revision: 2 });
    expect(rowTexts(container)).toEqual(["55%"]);
    expect(followCalls()).toEqual([true, false, true]);
  });

  it("keeps a push over a read it overtook", async () => {
    let answer!: (snapshot: AgentUsageTrackingSnapshot) => void;
    installBridge(new Promise<AgentUsageTrackingSnapshot>((resolve) => (answer = resolve)));
    const { container } = await renderBar();
    await pushTracking({ enabled: false, revision: 1 });
    await act(async () => answer({ enabled: true, revision: 0 }));
    expect(section(container)).toBeNull();
    expect(followCalls()).toEqual([]);
  });
});

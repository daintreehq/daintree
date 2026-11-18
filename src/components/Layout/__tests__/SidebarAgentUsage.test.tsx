// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { AgentUsageReadout, AgentUsageSnapshot } from "@shared/types/ipc/agentUsage";

const { dispatch, view } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  view: {
    observable: true,
    listeners: new Set<(observable: boolean) => void>(),
  },
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewObservable: () => view.observable,
  subscribeProjectViewObservability: (listener: (observable: boolean) => void) => {
    view.listeners.add(listener);
    return () => view.listeners.delete(listener);
  },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarAgentUsage } from "../SidebarAgentUsage";

const NOW = Date.now();

function codex(usedPercent: number, overrides: Partial<AgentUsageReadout> = {}): AgentUsageReadout {
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
      observedAt: NOW,
    },
    ...overrides,
  };
}

function claude(
  overrides: Partial<Extract<AgentUsageReadout["reading"], { agentId: "claude" }>> = {}
): AgentUsageReadout {
  return {
    hostId: "local",
    hostName: null,
    reading: {
      agentId: "claude",
      accountNames: [],
      isDefault: true,
      window: "weekly limit",
      statement: "approaching",
      usedPercent: null,
      resetsAt: null,
      observedAt: NOW - 12 * 60_000,
      ...overrides,
    },
  };
}

let pushed: ((snapshot: AgentUsageSnapshot) => void) | null = null;
const setFollowing =
  vi.fn<(payload: { following: boolean }) => Promise<AgentUsageSnapshot | null>>();

function installBridge(seed: AgentUsageReadout[] | (() => Promise<AgentUsageSnapshot>)) {
  setFollowing.mockImplementation(async ({ following }) => {
    if (!following) return null;
    return typeof seed === "function" ? seed() : { readouts: seed, revision: 1 };
  });
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      agentUsage: {
        setFollowing,
        onChanged: (callback: (snapshot: AgentUsageSnapshot) => void) => {
          pushed = callback;
          return () => (pushed = null);
        },
      },
    },
  });
}

function setObservable(observable: boolean) {
  view.observable = observable;
  act(() => {
    for (const listener of [...view.listeners]) listener(observable);
  });
}

async function renderUsage() {
  const rendered = render(
    <TooltipProvider>
      <SidebarAgentUsage />
    </TooltipProvider>
  );
  await act(async () => {});
  return rendered;
}

function rows(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("[data-sidebar-agent-usage-row]")];
}

function followCalls() {
  return setFollowing.mock.calls.map(([payload]) => payload.following);
}

describe("SidebarAgentUsage", () => {
  beforeEach(() => {
    dispatch.mockReset();
    setFollowing.mockReset();
    view.observable = true;
    view.listeners.clear();
  });

  afterEach(() => {
    cleanup();
    pushed = null;
    Reflect.deleteProperty(window, "electron");
    Reflect.deleteProperty(window, "__DAINTREE_HOST_ID__");
  });

  it("renders nothing while no agent has a reading", async () => {
    installBridge([]);
    const { container } = await renderUsage();
    expect(container.querySelector("[data-sidebar-agent-usage]")).toBeNull();
  });

  it("follows only while the view can be seen", async () => {
    view.observable = false;
    installBridge([codex(30)]);
    await renderUsage();
    expect(followCalls()).toEqual([]);
    setObservable(true);
    await act(async () => {});
    expect(followCalls()).toEqual([true]);
    setObservable(false);
    await act(async () => {});
    expect(followCalls()).toEqual([true, false]);
  });

  it("shows the tightest reading per agent across this machine and linked hosts, whatever order they came in", async () => {
    installBridge([
      codex(91, { hostId: "vps", hostName: "Build VPS" }),
      codex(40),
      claude(),
      claude({ statement: "used", usedPercent: 20 }),
    ]);
    const { container } = await renderUsage();
    const shown = rows(container);
    expect(shown.map((row) => row.textContent)).toEqual([
      "Codex 91% · Work · Build VPS",
      "Claude approaching weekly limit12m ago",
    ]);
    expect(shown.every((row) => row.hasAttribute("data-attention"))).toBe(true);
  });

  it("opens this machine's account quota section for the agent the line is for", async () => {
    installBridge([codex(30), claude({ statement: "used", usedPercent: 10 })]);
    const { container } = await renderUsage();
    const [codexRow, claudeRow] = rows(container);
    expect(codexRow!.hasAttribute("data-attention")).toBe(false);
    fireEvent.click(codexRow!);
    fireEvent.click(claudeRow!);
    expect(dispatch.mock.calls.map(([, args]) => args)).toEqual([
      { tab: "agents", subtab: "codex", sectionId: "agents-account-quota" },
      { tab: "agents", subtab: "claude", sectionId: "agents-account-quota" },
    ]);
  });

  it("says which window has a linked host's quota rather than act on another machine", async () => {
    installBridge([codex(91, { hostId: "vps", hostName: "Build VPS" })]);
    const { container } = await renderUsage();
    const [row] = rows(container);
    expect(row!.tagName).toBe("DIV");
    expect(row!.getAttribute("aria-label")).toMatch(
      /Its account quota shows in a window on Build VPS$/
    );
    fireEvent.click(row!);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("names this machine in a window on a host", async () => {
    Object.defineProperty(window, "__DAINTREE_HOST_ID__", {
      configurable: true,
      value: { id: "vps" },
    });
    installBridge([codex(30)]);
    const { container } = await renderUsage();
    const [row] = rows(container);
    expect(row!.textContent).toBe("Codex 30% · Work · This machine");
    expect(row!.getAttribute("aria-label")).toMatch(/shows in a window on this machine$/);
  });

  it("drops a seed that a newer push overtook, and hides once nothing is left", async () => {
    let resolveSeed!: (snapshot: AgentUsageSnapshot) => void;
    installBridge(() => new Promise((resolve) => (resolveSeed = resolve)));
    const { container } = await renderUsage();
    act(() => pushed!({ readouts: [codex(85)], revision: 2 }));
    await act(async () => resolveSeed({ readouts: [codex(10)], revision: 1 }));
    expect(rows(container)[0]!.textContent).toBe("Codex 85% · Work");
    act(() => pushed!({ readouts: [codex(10)], revision: 1 }));
    expect(rows(container)[0]!.textContent).toBe("Codex 85% · Work");
    act(() => pushed!({ readouts: [], revision: 3 }));
    expect(container.querySelector("[data-sidebar-agent-usage]")).toBeNull();
  });

  it("stops following and listening when it unmounts, ignoring a seed that lands after", async () => {
    let resolveSeed!: (snapshot: AgentUsageSnapshot) => void;
    installBridge(() => new Promise((resolve) => (resolveSeed = resolve)));
    const { unmount } = await renderUsage();
    unmount();
    expect(followCalls()).toEqual([true, false]);
    expect(pushed).toBeNull();
    await act(async () => resolveSeed({ readouts: [codex(99)], revision: 1 }));
  });
});

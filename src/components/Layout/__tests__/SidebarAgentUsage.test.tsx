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
/** A reset this close, and a wait well past it but far short of the minute clock. */
const RESET_IN_MS = 60;
const PAST_RESET_MS = 150;

function codex(
  usedPercent: number,
  overrides: Partial<AgentUsageReadout> = {},
  reading: Partial<Extract<AgentUsageReadout["reading"], { agentId: "codex" }>> = {}
): AgentUsageReadout {
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
      ...reading,
    },
    ...overrides,
  };
}

function claude(
  overrides: Partial<Extract<AgentUsageReadout["reading"], { agentId: "claude" }>> = {},
  host: Partial<Omit<AgentUsageReadout, "reading">> = {}
): AgentUsageReadout {
  return {
    hostId: "local",
    hostName: null,
    ...host,
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

const STUDIO = { hostId: "studio-03", hostName: "studio-03" };
const VPS = { hostId: "vps", hostName: "Build VPS" };

function showHost(id: string) {
  Object.defineProperty(window, "__DAINTREE_HOST_ID__", { configurable: true, value: { id } });
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

  it("shows the tightest reading per agent of this machine alone, whatever order they came in", async () => {
    installBridge([
      codex(91, VPS),
      codex(40),
      claude({ statement: "used", usedPercent: 20 }),
      claude(),
      claude({ statement: "reached" }, VPS),
    ]);
    const { container } = await renderUsage();
    expect(rows(container).map((row) => row.textContent)).toEqual([
      "Codex 40% · Work",
      "Claude approaching weekly limit12m ago",
    ]);
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

  it("shows a host window that host's own reading, though this machine's and another host's are tighter", async () => {
    showHost("studio-03");
    const resetsAt = NOW + 3 * 86_400_000;
    installBridge([
      claude({ statement: "used", usedPercent: 85, resetsAt }),
      claude({ statement: "used", usedPercent: 45, resetsAt }, STUDIO),
      claude({ statement: "reached" }, VPS),
    ]);
    const { container } = await renderUsage();
    const shown = rows(container);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.textContent).toMatch(/^Claude 45% · studio-03 · resets /);
    expect(shown[0]!.textContent).not.toMatch(/This machine/);
    expect(shown[0]!.hasAttribute("data-attention")).toBe(false);
    expect(shown[0]!.tagName).toBe("BUTTON");
    fireEvent.click(shown[0]!);
    expect(dispatch.mock.calls).toEqual([
      [
        "app.settings.openTab",
        { tab: "agents", subtab: "claude", sectionId: "agents-account-quota" },
        { source: "user" },
      ],
    ]);
  });

  it("follows its own host's readings as they change, and shows nothing once only other machines have one", async () => {
    showHost("studio-03");
    installBridge([codex(20, STUDIO), codex(95)]);
    const { container } = await renderUsage();
    expect(rows(container).map((row) => row.textContent)).toEqual(["Codex 20% · Work · studio-03"]);
    act(() => pushed!({ readouts: [codex(95), codex(55, STUDIO)], revision: 2 }));
    expect(rows(container).map((row) => row.textContent)).toEqual(["Codex 55% · Work · studio-03"]);
    act(() => pushed!({ readouts: [codex(95), codex(99, VPS)], revision: 3 }));
    expect(container.querySelector("[data-sidebar-agent-usage]")).toBeNull();
  });

  it("lets a newer push with none of its host's readings overtake an older seed that had one", async () => {
    showHost("studio-03");
    let resolveSeed!: (snapshot: AgentUsageSnapshot) => void;
    installBridge(() => new Promise((resolve) => (resolveSeed = resolve)));
    const { container } = await renderUsage();
    act(() => pushed!({ readouts: [codex(95)], revision: 2 }));
    await act(async () => resolveSeed({ readouts: [codex(40, STUDIO)], revision: 1 }));
    expect(container.querySelector("[data-sidebar-agent-usage]")).toBeNull();
  });

  it("never picks between two machines' readings that carry the same login name", async () => {
    const login = { isDefault: true, defaultLoginName: "Personal" };
    const readouts = [
      claude({ ...login, statement: "used", usedPercent: 30 }),
      claude({ ...login, statement: "used", usedPercent: 90 }, VPS),
    ];
    installBridge(readouts);
    const here = await renderUsage();
    expect(rows(here.container).map((row) => row.textContent)).toEqual([
      "Claude 30% · Personal12m ago",
    ]);
    here.unmount();

    showHost("vps");
    installBridge([...readouts].reverse());
    const there = await renderUsage();
    expect(rows(there.container).map((row) => row.textContent)).toEqual([
      "Claude 90% · Personal · Build VPS12m ago",
    ]);
  });

  it("shows nothing for an agent whose only reading is another machine's", async () => {
    installBridge([codex(91, VPS), claude({ statement: "used", usedPercent: 10 })]);
    const { container } = await renderUsage();
    expect(rows(container).map((row) => row.getAttribute("data-sidebar-agent-usage-row"))).toEqual([
      "claude",
    ]);
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

  it("clears what it held when a follow is refused and only an older push came meanwhile", async () => {
    const answers: Array<(snapshot: AgentUsageSnapshot | Error) => void> = [];
    installBridge(
      () =>
        new Promise<AgentUsageSnapshot>((resolve, reject) =>
          answers.push((value) => (value instanceof Error ? reject(value) : resolve(value)))
        )
    );
    const { container } = await renderUsage();
    await act(async () => answers[0]!({ readouts: [codex(85)], revision: 3 }));
    expect(rows(container)).toHaveLength(1);
    setObservable(false);
    setObservable(true);
    await act(async () => {});
    act(() => pushed!({ readouts: [codex(85)], revision: 2 }));
    await act(async () => answers[1]!(new Error("refused")));
    expect(container.querySelector("[data-sidebar-agent-usage]")).toBeNull();
  });

  it("hands over to the next reading at the shown one's reset, not a minute later", async () => {
    const resetsAt = Date.now() + RESET_IN_MS;
    installBridge([codex(95, {}, { resetsAt }), codex(70, {}, { windowDurationMins: 10080 })]);
    const { container } = await renderUsage();
    expect(rows(container)[0]!.textContent).toMatch(/^Codex 95%/);
    await act(() => new Promise((resolve) => setTimeout(resolve, PAST_RESET_MS)));
    expect(rows(container)[0]!.textContent).toBe("Codex 70% · Work");
  });
});

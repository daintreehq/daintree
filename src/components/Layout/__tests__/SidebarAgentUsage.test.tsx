// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentUsageReadout, AgentUsageSnapshot } from "@shared/types/ipc/agentUsage";
import { AGENT_USAGE_SHOWN_FOR_MS } from "@shared/utils/agentUsage";

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

import ClaudeIcon from "@/components/icons/brands/ClaudeIcon";
import CodexIcon from "@/components/icons/brands/CodexIcon";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AGENT_USAGE_EXPANDED_KEY, setAgentUsageExpanded } from "../agentUsageExpanded";
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

function header(container: HTMLElement) {
  return container.querySelector<HTMLElement>("[data-sidebar-agent-usage-toggle]")!;
}

function described(element: HTMLElement) {
  return document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent;
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
    setAgentUsageExpanded(true);
    localStorage.removeItem(AGENT_USAGE_EXPANDED_KEY);
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
    expect(rows(container).map((row) => row.textContent)).toEqual(["40%", "Near limit"]);
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
    expect(shown[0]!.textContent).toMatch(/^45% · resets /);
    expect(shown[0]!.textContent).not.toMatch(/studio-03|This machine/);
    expect(shown[0]!.getAttribute("aria-label")).toMatch(/^Claude 45% · studio-03 · resets /);
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
    expect(rows(container).map((row) => row.textContent)).toEqual(["20%"]);
    act(() => pushed!({ readouts: [codex(95), codex(55, STUDIO)], revision: 2 }));
    expect(rows(container).map((row) => row.textContent)).toEqual(["55%"]);
    expect(rows(container)[0]!.getAttribute("aria-label")).toMatch(/^Codex 55% · Work · studio-03/);
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
    expect(rows(here.container).map((row) => row.textContent)).toEqual(["30%"]);
    expect(rows(here.container)[0]!.getAttribute("aria-label")).toMatch(
      /^Claude 30% · Personal\. .*12m ago/
    );
    here.unmount();

    showHost("vps");
    installBridge([...readouts].reverse());
    const there = await renderUsage();
    expect(rows(there.container).map((row) => row.textContent)).toEqual(["90%"]);
    expect(rows(there.container)[0]!.getAttribute("aria-label")).toMatch(
      /^Claude 90% · Personal · Build VPS\. .*12m ago/
    );
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
    expect(rows(container)[0]!.textContent).toBe("85%");
    act(() => pushed!({ readouts: [codex(10)], revision: 1 }));
    expect(rows(container)[0]!.textContent).toBe("85%");
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
    expect(rows(container)[0]!.textContent).toMatch(/^95% · resets /);
    await act(() => new Promise((resolve) => setTimeout(resolve, PAST_RESET_MS)));
    expect(rows(container)[0]!.textContent).toBe("70%");
  });

  describe("the Usage section", () => {
    it("heads its rows with a toggle that names the list it controls", async () => {
      installBridge([codex(30), claude({ statement: "used", usedPercent: 10 })]);
      const { container } = await renderUsage();
      const toggle = header(container);
      expect(toggle.tagName).toBe("BUTTON");
      expect(toggle.getAttribute("type")).toBe("button");
      expect(toggle.textContent).toBe("Usage");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      const list = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
      expect(list?.hidden).toBe(false);
      expect(rows(list!)).toHaveLength(2);
      expect(toggle.hasAttribute("data-attention")).toBe(false);
    });

    it("shows each agent's own icon in place of the gauge, and keeps the detail out of the row", async () => {
      const resetsAt = NOW + 3 * 86_400_000;
      installBridge([
        codex(30, {}, { resetsAt }),
        claude({ statement: "used", usedPercent: 85, resetsAt, defaultLoginName: "Home" }),
      ]);
      const { container } = await renderUsage();
      const [codexRow, claudeRow] = rows(container);
      for (const row of [codexRow!, claudeRow!]) {
        expect(row.querySelector("svg.lucide-gauge")).toBeNull();
        expect(row.querySelectorAll("svg")).toHaveLength(1);
        expect(row.textContent).toMatch(/^\d+% · resets \S/);
      }
      // Each row wears its own agent's mark, not just a different one.
      const drawing = (root: Element) => root.querySelector("svg path")!.getAttribute("d");
      expect(drawing(codexRow!)).toBe(drawing(render(<CodexIcon />).container));
      expect(drawing(claudeRow!)).toBe(drawing(render(<ClaudeIcon />).container));
      expect(drawing(codexRow!)).not.toBe(drawing(claudeRow!));
      expect(claudeRow!.textContent).not.toMatch(/Claude|Home|ago/);
      const label = claudeRow!.getAttribute("aria-label")!;
      expect(label).toMatch(/^Claude 85% · Home · resets /);
      expect(label).toMatch(/Home · default login\./);
      expect(label).toMatch(/Printed in a terminal 12m ago\. Open account quota$/);
    });

    it("keeps the login, machine and age a row leaves out in its tooltip", async () => {
      showHost("studio-03");
      installBridge([
        claude({ statement: "used", usedPercent: 30, defaultLoginName: "Home" }, STUDIO),
      ]);
      const { container } = await renderUsage();
      fireEvent.focus(rows(container)[0]!);
      const tip = (await screen.findAllByRole("tooltip"))[0]!;
      expect(tip.textContent).toMatch(/Claude/);
      expect(tip.textContent).toMatch(/Home · default login on studio-03/);
      expect(tip.textContent).toMatch(/Printed in a terminal 12m ago/);
      expect(tip.textContent).toMatch(/Open account quota/);
    });

    it("folds to its header alone on one click, and opens again on the next", async () => {
      installBridge([codex(30), claude({ statement: "used", usedPercent: 10 })]);
      const { container } = await renderUsage();
      const toggle = header(container);
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(rows(container)).toHaveLength(0);
      const list = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
      expect(list?.hidden).toBe(true);
      expect(container.textContent).toBe("Usage");
      expect(dispatch).not.toHaveBeenCalled();
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(rows(container)).toHaveLength(2);
      expect(toggle.textContent).toBe("Usage");
    });

    it("takes the warning tone folded, for a figure past the threshold, without the figures", async () => {
      installBridge([codex(30), claude({ statement: "used", usedPercent: 85 })]);
      const { container } = await renderUsage();
      const toggle = header(container);
      // Open, the rows carry the tone and the header stays plain.
      expect(toggle.hasAttribute("data-attention")).toBe(false);
      expect(rows(container).map((row) => row.hasAttribute("data-attention"))).toEqual([
        false,
        true,
      ]);
      fireEvent.click(toggle);
      expect(toggle.hasAttribute("data-attention")).toBe(true);
      expect(toggle.querySelector("svg.lucide-triangle-alert")).not.toBeNull();
      expect(described(toggle)).toBe("An agent is near or at its usage limit");
      expect(container.textContent).not.toMatch(/\d+%/);
      // The name never changes with the state; the warning only describes it.
      const folded = toggle.getAttribute("aria-label");
      expect(folded).toBeTruthy();
      expect(folded).not.toMatch(/\d|limit/i);
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-label")).toBe(folded);
      expect(toggle.hasAttribute("data-attention")).toBe(false);
      expect(toggle.hasAttribute("aria-describedby")).toBe(false);
    });

    it("takes the warning tone folded when Claude Code said the limit is near or reached", async () => {
      const quiet = claude({ statement: "used", usedPercent: 79 });
      installBridge([quiet]);
      const { container } = await renderUsage();
      fireEvent.click(header(container));
      expect(header(container).hasAttribute("data-attention")).toBe(false);
      let revision = 1;
      for (const statement of ["approaching", "reached"] as const) {
        act(() =>
          pushed!({ readouts: [claude({ statement, usedPercent: null })], revision: ++revision })
        );
        expect(header(container).hasAttribute("data-attention")).toBe(true);
        act(() => pushed!({ readouts: [quiet], revision: ++revision }));
        expect(header(container).hasAttribute("data-attention")).toBe(false);
      }
    });

    it("stays plain folded while every reading is under the threshold", async () => {
      installBridge([codex(79), claude({ statement: "used", usedPercent: 10 })]);
      const { container } = await renderUsage();
      fireEvent.click(header(container));
      expect(header(container).hasAttribute("data-attention")).toBe(false);
      expect(header(container).querySelector("svg")).not.toBeNull();
      expect(header(container).querySelectorAll("svg")).toHaveLength(1);
    });

    it("warns for its own host's readings alone, folded", async () => {
      showHost("studio-03");
      installBridge([codex(99), codex(97, VPS), codex(20, STUDIO)]);
      const { container } = await renderUsage();
      fireEvent.click(header(container));
      expect(header(container).hasAttribute("data-attention")).toBe(false);
      act(() => pushed!({ readouts: [codex(20), codex(95, STUDIO)], revision: 2 }));
      expect(header(container).hasAttribute("data-attention")).toBe(true);
    });

    it("drops the folded warning at the warned reading's reset, with no new snapshot", async () => {
      // Only the clock and the reset's own timer are faked; the bridge's promises stay real.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const resetsAt = Date.now() + 30_000;
        installBridge([codex(95, {}, { resetsAt }), codex(70, {}, { windowDurationMins: 10080 })]);
        const { container } = await renderUsage();
        fireEvent.click(header(container));
        expect(header(container).hasAttribute("data-attention")).toBe(true);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(29_000);
        });
        expect(header(container).hasAttribute("data-attention")).toBe(true);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_000);
        });
        expect(header(container).hasAttribute("data-attention")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("goes, warning and all, once its last reading ages out, with no new snapshot (#18159)", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const observedAt = Date.now() - AGENT_USAGE_SHOWN_FOR_MS + 30_000;
        const resetsAt = Date.now() + 3 * 86_400_000;
        installBridge([
          claude({ statement: "used", usedPercent: 99, resetsAt, observedAt }),
          codex(90, VPS, { observedAt: Date.now() }),
        ]);
        const { container } = await renderUsage();
        fireEvent.click(header(container));
        expect(header(container).hasAttribute("data-attention")).toBe(true);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(29_000);
        });
        expect(header(container).hasAttribute("data-attention")).toBe(true);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_000);
        });
        expect(container.querySelector("[data-sidebar-agent-usage]")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ages a reading out on time when it arrives well after the last minute sample", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        installBridge([codex(30)]);
        const { container } = await renderUsage();
        // The wall clock moves on without the minute clock seeing it.
        vi.setSystemTime(Date.now() + 20_000);
        const observedAt = Date.now() - AGENT_USAGE_SHOWN_FOR_MS + 30_000;
        act(() =>
          pushed!({
            readouts: [
              codex(30),
              claude({ statement: "used", usedPercent: 99, resetsAt: null, observedAt }),
            ],
            revision: 2,
          })
        );
        expect(rows(container)).toHaveLength(2);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(29_000);
        });
        expect(rows(container)).toHaveLength(2);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_000);
        });
        expect(rows(container).map((row) => row.textContent)).toEqual(["30%"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never shows a reading older than the span, letting a fresher looser one take the row", async () => {
      const resetsAt = NOW + 3 * 86_400_000;
      installBridge([
        claude({
          statement: "used",
          usedPercent: 99,
          resetsAt,
          observedAt: Date.now() - AGENT_USAGE_SHOWN_FOR_MS - 1,
        }),
        claude({ statement: "used", usedPercent: 15, resetsAt, observedAt: Date.now() }),
      ]);
      const { container } = await renderUsage();
      expect(rows(container)).toHaveLength(1);
      expect(rows(container)[0]!.textContent).toMatch(/^15% · resets /);
      expect(header(container).hasAttribute("data-attention")).toBe(false);
    });

    it("leaves no section folded when nothing has a reading, and returns folded when one does", async () => {
      installBridge([codex(30)]);
      const { container } = await renderUsage();
      fireEvent.click(header(container));
      act(() => pushed!({ readouts: [], revision: 2 }));
      expect(container.querySelector("[data-sidebar-agent-usage]")).toBeNull();
      act(() => pushed!({ readouts: [claude()], revision: 3 }));
      expect(header(container).getAttribute("aria-expanded")).toBe("false");
      expect(header(container).hasAttribute("data-attention")).toBe(true);
      expect(rows(container)).toHaveLength(0);
    });

    describe("remembering the fold", () => {
      it("opens by default and keeps what a click wrote across a remount", async () => {
        installBridge([codex(30)]);
        const first = await renderUsage();
        expect(header(first.container).getAttribute("aria-expanded")).toBe("true");
        fireEvent.click(header(first.container));
        expect(localStorage.getItem(AGENT_USAGE_EXPANDED_KEY)).toBe("false");
        first.unmount();

        const second = await renderUsage();
        expect(header(second.container).getAttribute("aria-expanded")).toBe("false");
        expect(rows(second.container)).toHaveLength(0);
        fireEvent.click(header(second.container));
        expect(localStorage.getItem(AGENT_USAGE_EXPANDED_KEY)).toBe("true");
      });

      it("starts folded when a previous session left it folded", async () => {
        // The stored key is the contract with earlier sessions, so it is spelled out here.
        localStorage.setItem("daintree_agent_usage_expanded", "false");
        installBridge([codex(30)]);
        const { container } = await renderUsage();
        expect(header(container).getAttribute("aria-expanded")).toBe("false");
        expect(rows(container)).toHaveLength(0);
      });

      it("follows another window's change", async () => {
        installBridge([codex(30)]);
        const { container } = await renderUsage();
        localStorage.setItem(AGENT_USAGE_EXPANDED_KEY, "false");
        act(() => {
          window.dispatchEvent(
            new StorageEvent("storage", {
              key: AGENT_USAGE_EXPANDED_KEY,
              oldValue: "true",
              newValue: "false",
              storageArea: localStorage,
            })
          );
        });
        expect(header(container).getAttribute("aria-expanded")).toBe("false");
        expect(rows(container)).toHaveLength(0);
        localStorage.setItem(AGENT_USAGE_EXPANDED_KEY, "true");
        act(() => {
          window.dispatchEvent(new StorageEvent("storage", { key: AGENT_USAGE_EXPANDED_KEY }));
        });
        expect(header(container).getAttribute("aria-expanded")).toBe("true");
        expect(rows(container)).toHaveLength(1);
      });

      it("still folds in a view that can't write storage", async () => {
        installBridge([codex(30)]);
        const { container } = await renderUsage();
        const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new Error("quota");
        });
        try {
          fireEvent.click(header(container));
          expect(header(container).getAttribute("aria-expanded")).toBe("false");
          expect(rows(container)).toHaveLength(0);
        } finally {
          setItem.mockRestore();
        }
        // Another window's write proves storage works again, and is what this one follows.
        localStorage.setItem(AGENT_USAGE_EXPANDED_KEY, "true");
        act(() => {
          window.dispatchEvent(new StorageEvent("storage", { key: AGENT_USAGE_EXPANDED_KEY }));
        });
        expect(header(container).getAttribute("aria-expanded")).toBe("true");
      });
    });
  });
});

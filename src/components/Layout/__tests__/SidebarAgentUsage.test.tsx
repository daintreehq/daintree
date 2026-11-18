// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type {
  AgentUsageReadout,
  AgentUsageSnapshot,
} from "@shared/types/ipc/agentUsage";

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

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

function claudeApproaching(): AgentUsageReadout {
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
      observedAt: NOW,
    },
  };
}

let pushed: ((snapshot: AgentUsageSnapshot) => void) | null = null;
const setFollowing = vi.fn();

function installBridge(seed: AgentUsageReadout[]) {
  setFollowing.mockImplementation(async ({ following }: { following: boolean }) =>
    following ? { readouts: seed, revision: 1 } : null
  );
  (window as unknown as { electron: unknown }).electron = {
    agentUsage: {
      setFollowing,
      onChanged: (callback: (snapshot: AgentUsageSnapshot) => void) => {
        pushed = callback;
        return () => (pushed = null);
      },
    },
  };
}

async function renderUsage() {
  const view = render(
    <TooltipProvider>
      <SidebarAgentUsage />
    </TooltipProvider>
  );
  await act(async () => {});
  return view;
}

function rows(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("[data-sidebar-agent-usage-row]")];
}

describe("SidebarAgentUsage", () => {
  beforeEach(() => {
    dispatch.mockReset();
    setFollowing.mockReset();
  });

  afterEach(() => {
    cleanup();
    pushed = null;
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it("renders nothing while no agent has a reading, and still follows", async () => {
    installBridge([]);
    const { container } = await renderUsage();
    expect(container.querySelector("[data-sidebar-agent-usage]")).toBeNull();
    expect(setFollowing).toHaveBeenCalledWith({ following: true });
  });

  it("shows the tightest reading per agent across this machine and linked hosts", async () => {
    installBridge([
      codex(40),
      codex(91, { hostId: "vps", hostName: "Build VPS" }),
      claudeApproaching(),
    ]);
    const { container } = await renderUsage();
    const shown = rows(container);
    expect(shown.map((row) => row.textContent)).toEqual([
      "Codex 91% · Work · Build VPS",
      "Claude approaching weekly limit",
    ]);
    expect(shown.every((row) => row.hasAttribute("data-attention"))).toBe(true);
    // A reading from another machine has no section here to open.
    expect(shown[0]!.tagName).toBe("DIV");
    expect(shown[1]!.tagName).toBe("BUTTON");
  });

  it("opens this machine's account quota section for its agent", async () => {
    installBridge([codex(30)]);
    const { container } = await renderUsage();
    const [row] = rows(container);
    expect(row!.hasAttribute("data-attention")).toBe(false);
    fireEvent.click(row!);
    expect(dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "agents", subtab: "codex", sectionId: "agents-account-quota" },
      { source: "user" }
    );
  });

  it("takes a newer push over the seed, and hides once nothing is left", async () => {
    installBridge([codex(30)]);
    const { container } = await renderUsage();
    act(() => pushed!({ readouts: [codex(85)], revision: 2 }));
    expect(rows(container)[0]!.textContent).toBe("Codex 85% · Work");
    // An older revision arriving late is dropped.
    act(() => pushed!({ readouts: [codex(10)], revision: 1 }));
    expect(rows(container)[0]!.textContent).toBe("Codex 85% · Work");
    act(() => pushed!({ readouts: [], revision: 3 }));
    expect(container.querySelector("[data-sidebar-agent-usage]")).toBeNull();
  });

  it("stops following when it unmounts", async () => {
    installBridge([codex(30)]);
    const { unmount } = await renderUsage();
    unmount();
    expect(setFollowing).toHaveBeenLastCalledWith({ following: false });
  });
});

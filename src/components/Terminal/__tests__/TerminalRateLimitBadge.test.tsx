// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const clock = vi.hoisted(() => ({ now: 0 }));
const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const readQuota = vi.hoisted(() => vi.fn());
vi.mock("@/clients/codexClient", () => ({
  codexClient: {
    readQuota: (...args: unknown[]) => readQuota(...args),
    refreshQuota: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));
vi.mock("@/hooks/useGlobalMinuteTicker", () => ({
  useGlobalMinuteClock: () => clock.now,
}));
const setContinue = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/clients/codexLimitContinueClient", () => ({
  codexLimitContinueClient: {
    set: (...args: unknown[]) => setContinue(...args),
    list: vi.fn().mockResolvedValue([]),
  },
}));

import { TerminalRateLimitBadge } from "../TerminalRateLimitBadge";
import {
  RATE_LIMIT_OBSERVATION_TTL_MS,
  useRateLimitObservationStore,
} from "@/store/rateLimitObservationStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCodexLimitContinueStore } from "@/store/codexLimitContinueStore";
import { setLeaseInputBlock } from "@/services/terminal/inputGate";
import { LIMIT_CONTINUE_OUTCOME_TTL_MS } from "../limitContinueChipModel";
import type { AgentSettings } from "@shared/types/agentSettings";
import type { CodexLimitContinueState } from "@shared/types/codexLimitContinuation";
import type { PtyPanelData } from "@shared/types/panel";

function renderBadge(terminalId: string) {
  return render(
    <TooltipProvider>
      <TerminalRateLimitBadge terminalId={terminalId} />
    </TooltipProvider>
  );
}

beforeEach(() => {
  readQuota.mockReset().mockResolvedValue([]);
  setContinue.mockReset().mockResolvedValue(undefined);
  dispatchMock.mockClear();
});

afterEach(() => {
  cleanup();
  useRateLimitObservationStore.setState({ observedAtByTerminalId: {} });
  useCodexLimitContinueStore.setState({ panes: {}, disarmed: {} });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  useAgentSettingsStore.setState({ settings: null });
  setLeaseInputBlock(null);
});

describe("TerminalRateLimitBadge (#12797)", () => {
  it("renders nothing for a pane with no observation or continuation", () => {
    renderBadge("t1");
    expect(screen.queryByTestId("terminal-rate-limit-badge")).toBeNull();
  });

  it("shows the observation only on the pane it was seen in", () => {
    const observedAt = 1_700_000_000_000;
    clock.now = observedAt + 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });

    renderBadge("t1");
    renderBadge("t2");

    const badges = screen.queryAllByTestId("terminal-rate-limit-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe("Rate limit reported");
  });

  it("disappears once the retention window has passed", () => {
    const observedAt = 1_700_000_000_000;
    clock.now = observedAt + RATE_LIMIT_OBSERVATION_TTL_MS - 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });

    const view = renderBadge("t1");
    expect(screen.queryByTestId("terminal-rate-limit-badge")).not.toBeNull();

    clock.now = observedAt + RATE_LIMIT_OBSERVATION_TTL_MS;
    view.rerender(
      <TooltipProvider>
        <TerminalRateLimitBadge terminalId="t1" />
      </TooltipProvider>
    );
    expect(screen.queryByTestId("terminal-rate-limit-badge")).toBeNull();
  });

  it("stays a status chip on a pane with nowhere else to move (#13746)", () => {
    const observedAt = 1_700_000_000_000;
    clock.now = observedAt + 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });

    renderBadge("t1");

    const badge = screen.getByTestId("terminal-rate-limit-badge");
    expect(badge.tagName).toBe("DIV");
    expect(badge.getAttribute("role")).toBe("status");
  });

  it("opens a preset menu on an agent pane that has another preset (#13746)", () => {
    const observedAt = 1_700_000_000_000;
    clock.now = observedAt + 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });
    const settings: AgentSettings = {
      agents: {
        codex: {
          customPresets: [
            { id: "personal", name: "Personal" },
            { id: "work", name: "Work" },
          ],
        },
      },
    };
    useAgentSettingsStore.setState({ settings });
    const pane: PtyPanelData = {
      id: "t1",
      kind: "terminal",
      title: "Codex [Personal]",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      location: "grid",
      launchAgentId: "codex",
      agentPresetId: "personal",
    };
    usePanelStore.setState({ panelsById: { t1: pane }, panelIds: ["t1"] });

    renderBadge("t1");

    const badge = screen.getByTestId("terminal-rate-limit-badge");
    expect(badge.textContent).toBe("Rate limit reported");
    act(() => {
      fireEvent.keyDown(badge, { key: "Enter" });
    });

    // Only the other preset is offered; the pane is already on Personal.
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Work"]);
    act(() => {
      fireEvent.click(items[0]!);
    });

    // Asked even though the agent isn't working: the conversation ends either way.
    expect(screen.getByText("Restart 'Codex [Personal]' on 'Work'?")).toBeTruthy();
    expect(dispatchMock).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart on preset" }));
    });
    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.restartOnPreset",
      { terminalId: "t1", presetId: "work", confirmed: true },
      { source: "user" }
    );
  });

  it("shows each account's known quota window in the switch menu, read only once it opens (#16407)", async () => {
    const observedAt = 1_700_000_000_000;
    clock.now = observedAt + 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          codex: {
            accounts: [{ id: "lab", name: "Lab", configDir: "/Users/me/.codex-lab" }],
          },
        },
      } as AgentSettings,
    });
    readQuota.mockResolvedValue([
      {
        key: "lab",
        isDefault: false,
        presetNames: [],
        accountIds: ["lab"],
        result: {
          status: "ok",
          planType: null,
          windows: [{ usedPercent: 35, windowDurationMins: 10080, resetsAt: null }],
          fetchedAt: Date.now(),
        },
      },
    ]);
    const pane: PtyPanelData = {
      id: "t1",
      kind: "terminal",
      title: "Codex",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      location: "grid",
      launchAgentId: "codex",
    };
    usePanelStore.setState({ panelsById: { t1: pane }, panelIds: ["t1"] });

    renderBadge("t1");
    await act(async () => {});
    expect(readQuota).not.toHaveBeenCalled();

    act(() => {
      fireEvent.keyDown(screen.getByTestId("terminal-rate-limit-badge"), { key: "Enter" });
    });
    await act(async () => {});
    expect(readQuota).toHaveBeenCalled();
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    // The pane is on the default login, so the only move is to Lab.
    expect(items).toEqual(["LabWeekly limit 35% used"]);
  });

  it("gives the default login no window when the pane's preset puts the folder elsewhere (#16407)", async () => {
    const observedAt = 1_700_000_000_000;
    clock.now = observedAt + 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          codex: {
            accounts: [
              { id: "company", name: "Company", configDir: "/Users/me/.codex-company" },
              { id: "lab", name: "Lab", configDir: "/Users/me/.codex-lab" },
            ],
            customPresets: [
              { id: "legacy", name: "Legacy", env: { CODEX_HOME: "/Users/me/.codex-legacy" } },
            ],
          },
        },
      } as AgentSettings,
    });
    const quota = (key: string, patch: object, usedPercent: number) => ({
      key,
      isDefault: false,
      presetNames: [],
      ...patch,
      result: {
        status: "ok",
        planType: null,
        windows: [{ usedPercent, windowDurationMins: 10080, resetsAt: null }],
        fetchedAt: Date.now(),
      },
    });
    readQuota.mockResolvedValue([
      quota("default", { isDefault: true }, 10),
      quota("lab", { accountIds: ["lab"] }, 35),
    ]);
    const pane: PtyPanelData = {
      id: "t1",
      kind: "terminal",
      title: "Codex",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      location: "grid",
      launchAgentId: "codex",
      agentAccountId: "company",
      agentPresetId: "legacy",
    };
    usePanelStore.setState({ panelsById: { t1: pane }, panelIds: ["t1"] });

    renderBadge("t1");
    act(() => {
      fireEvent.keyDown(screen.getByTestId("terminal-rate-limit-badge"), { key: "Enter" });
    });
    await act(async () => {});
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["Default login", "LabWeekly limit 35% used"]);
  });
});

const codexPane = (extra: Partial<PtyPanelData> = {}): PtyPanelData => ({
  id: "t1",
  kind: "terminal",
  title: "Codex",
  cwd: "/repo",
  cols: 80,
  rows: 24,
  location: "grid",
  launchAgentId: "codex",
  ...extra,
});

function armWith(state: CodexLimitContinueState, revision = 2) {
  act(() => {
    useCodexLimitContinueStore
      .getState()
      .mergeSnapshot([{ terminalId: "t1", revision, state }], new Set());
  });
}

function openChipMenu() {
  act(() => {
    fireEvent.keyDown(screen.getByTestId("terminal-rate-limit-badge"), { key: "Enter" });
  });
}

// Local wall-clock instants, so the expectations hold in any time zone.
const local = (day: number, hour: number, minute: number) =>
  new Date(2026, 10, day, hour, minute).getTime();

describe("TerminalRateLimitBadge, armed to continue (#17911)", () => {
  it("shows when a wait days away resumes, with no observation, and turns it off from its menu", async () => {
    // Thursday morning; the weekly window resets Monday.
    clock.now = local(19, 9, 0);
    usePanelStore.setState({ panelsById: { t1: codexPane() }, panelIds: ["t1"] });
    renderBadge("t1");
    expect(screen.queryByTestId("terminal-rate-limit-badge")).toBeNull();

    const resetsAt = local(23, 9, 59);
    armWith({ status: "waiting", resetsAt, continueAt: resetsAt + 60_000 });
    const badge = screen.getByTestId("terminal-rate-limit-badge");
    expect(badge.textContent).toMatch(/^Resumes Mon 10:00\sAM$/u);

    // Past the observation's 15 minutes, the wait still shows.
    clock.now = local(21, 9, 0);
    armWith({ status: "waiting", resetsAt, continueAt: resetsAt + 60_000 }, 3);
    expect(screen.getByTestId("terminal-rate-limit-badge").textContent).toMatch(
      /^Resumes Mon 10:00\sAM$/u
    );

    openChipMenu();
    const row = screen.getByRole("menuitemcheckbox", { name: "Continue when usage limit resets" });
    expect(row.getAttribute("aria-checked")).toBe("true");
    act(() => {
      fireEvent.click(row);
    });
    await act(async () => {});
    expect(setContinue).toHaveBeenCalledWith("t1", false);
    expect(dispatchMock).not.toHaveBeenCalled();

    // Main's disarm is what takes the chip away.
    expect(screen.queryByTestId("terminal-rate-limit-badge")).not.toBeNull();
    act(() => {
      useCodexLimitContinueStore
        .getState()
        .applyChange({ terminalId: "t1", revision: 4, state: null });
    });
    expect(screen.queryByTestId("terminal-rate-limit-badge")).toBeNull();
  });

  it("follows a wait main moved to a later time", () => {
    clock.now = local(19, 15, 0);
    usePanelStore.setState({ panelsById: { t1: codexPane() }, panelIds: ["t1"] });
    renderBadge("t1");
    armWith({ status: "waiting", resetsAt: local(19, 15, 39), continueAt: local(19, 15, 40) });
    expect(screen.getByTestId("terminal-rate-limit-badge").textContent).toMatch(
      /^Resumes 3:40\sPM$/u
    );
    act(() => {
      useCodexLimitContinueStore.getState().applyChange({
        terminalId: "t1",
        revision: 3,
        state: { status: "waiting", resetsAt: local(19, 15, 39), continueAt: local(19, 15, 41) },
      });
    });
    expect(screen.getByTestId("terminal-rate-limit-badge").textContent).toMatch(
      /^Resumes 3:41\sPM$/u
    );
  });

  it("says how the wait ended for a day, then goes", () => {
    const continuedAt = local(19, 3, 41);
    clock.now = local(19, 8, 0);
    usePanelStore.setState({ panelsById: { t1: codexPane() }, panelIds: ["t1"] });
    const view = renderBadge("t1");
    armWith({ status: "continued", at: continuedAt, line: "continue" });
    const badge = screen.getByTestId("terminal-rate-limit-badge");
    expect(badge.textContent).toMatch(/^Resumed 3:41\sAM$/u);
    expect(badge.getAttribute("data-limit-continue")).toBe("continued");

    clock.now = continuedAt + LIMIT_CONTINUE_OUTCOME_TTL_MS;
    view.rerender(
      <TooltipProvider>
        <TerminalRateLimitBadge terminalId="t1" />
      </TooltipProvider>
    );
    expect(screen.queryByTestId("terminal-rate-limit-badge")).toBeNull();
  });

  it("says a skip and a missing reset time rather than a time", () => {
    clock.now = local(19, 8, 0);
    usePanelStore.setState({ panelsById: { t1: codexPane() }, panelIds: ["t1"] });
    renderBadge("t1");
    armWith({ status: "skipped", at: local(19, 3, 41), reason: "draft" });
    expect(screen.getByTestId("terminal-rate-limit-badge").textContent).toBe("Resume skipped");

    armWith({ status: "skipped", at: local(19, 7, 0), reason: "no-reset" }, 3);
    const badge = screen.getByTestId("terminal-rate-limit-badge");
    expect(badge.textContent).toBe("No reset time");
    expect(badge.getAttribute("data-limit-continue")).toBe("no-reset");
  });

  it("keeps the observation chip for an armed pane with no wait yet, its menu showing it armed", () => {
    const observedAt = local(19, 8, 0);
    clock.now = observedAt + 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });
    usePanelStore.setState({ panelsById: { t1: codexPane() }, panelIds: ["t1"] });
    renderBadge("t1");
    armWith({ status: "armed" });
    expect(screen.getByTestId("terminal-rate-limit-badge").textContent).toBe("Rate limit reported");
    openChipMenu();
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Continue when usage limit resets" })
        .getAttribute("aria-checked")
    ).toBe("true");
  });

  it("reads no quota for a menu holding only the continue row", async () => {
    clock.now = local(19, 9, 0);
    useAgentSettingsStore.setState({
      settings: { agents: { codex: { customPresets: [{ id: "only", name: "Only" }] } } },
    });
    usePanelStore.setState({
      panelsById: { t1: codexPane({ agentPresetId: "only" }) },
      panelIds: ["t1"],
    });
    renderBadge("t1");
    armWith({ status: "waiting", resetsAt: local(19, 15, 39), continueAt: local(19, 15, 40) });
    openChipMenu();
    await act(async () => {});
    expect(screen.getAllByRole("menuitemcheckbox")).toHaveLength(1);
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(readQuota).not.toHaveBeenCalled();
  });

  it("offers a move elsewhere during a wait, but not beside an outcome", async () => {
    clock.now = local(19, 9, 0);
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          codex: {
            customPresets: [
              { id: "personal", name: "Personal" },
              { id: "work", name: "Work" },
            ],
          },
        },
      },
    });
    usePanelStore.setState({
      panelsById: { t1: codexPane({ agentPresetId: "personal" }) },
      panelIds: ["t1"],
    });
    renderBadge("t1");
    armWith({ status: "waiting", resetsAt: local(19, 15, 39), continueAt: local(19, 15, 40) });
    openChipMenu();
    await act(async () => {});
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Work"]);
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });

    armWith({ status: "skipped", at: local(19, 8, 59), reason: "draft" }, 3);
    openChipMenu();
    await act(async () => {});
    expect(screen.getAllByRole("menuitemcheckbox")).toHaveLength(1);
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("can't turn the wait off from a view that doesn't drive the project", () => {
    clock.now = local(19, 9, 0);
    usePanelStore.setState({ panelsById: { t1: codexPane() }, panelIds: ["t1"] });
    act(() => {
      setLeaseInputBlock({ kind: "driven-elsewhere", driverName: "Laptop" });
    });
    renderBadge("t1");
    armWith({ status: "waiting", resetsAt: local(19, 15, 39), continueAt: local(19, 15, 40) });
    openChipMenu();
    const row = screen.getByRole("menuitemcheckbox", { name: "Continue when usage limit resets" });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      fireEvent.click(row);
    });
    expect(setContinue).not.toHaveBeenCalled();
  });

  it("keeps a restart confirm already asked once the wait it was asked from ends", () => {
    clock.now = local(19, 9, 0);
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          codex: {
            customPresets: [
              { id: "personal", name: "Personal" },
              { id: "work", name: "Work" },
            ],
          },
        },
      },
    });
    usePanelStore.setState({
      panelsById: { t1: codexPane({ title: "Codex [Personal]", agentPresetId: "personal" }) },
      panelIds: ["t1"],
    });
    renderBadge("t1");
    armWith({ status: "waiting", resetsAt: local(19, 15, 39), continueAt: local(19, 15, 40) });
    openChipMenu();
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    });
    expect(screen.getByText("Restart 'Codex [Personal]' on 'Work'?")).toBeTruthy();

    act(() => {
      useCodexLimitContinueStore
        .getState()
        .applyChange({ terminalId: "t1", revision: 3, state: null });
    });
    expect(screen.queryByTestId("terminal-rate-limit-badge")).toBeNull();
    expect(screen.getByText("Restart 'Codex [Personal]' on 'Work'?")).toBeTruthy();
  });
});

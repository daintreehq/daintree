// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

const getInfoMock = vi.hoisted(() => vi.fn());
vi.mock("@/clients/terminalClient", () => ({
  terminalClient: { getInfo: (...args: unknown[]) => getInfoMock(...args) },
}));

import {
  AccountSwitchDialog,
  buildAccountSwitchRequest,
  isAccountSwitchCandidate,
  readUsageLimitedPaneIds,
  type AccountSwitchNoticeState,
} from "../AccountSwitchNotice";
import { usePanelStore } from "@/store/panelStore";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

type PaneOverrides = Partial<Omit<PtyPanelData, "cols" | "rows">>;

const pane = (overrides: PaneOverrides = {}): PtyPanelData => ({
  id: "p1",
  kind: "terminal",
  title: "Claude",
  cwd: "/repo",
  cols: 80,
  rows: 24,
  location: "grid",
  launchAgentId: "claude",
  worktreeId: "wt-1",
  agentState: "waiting",
  ...overrides,
});

function seed(panes: PtyPanelData[]): void {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panes.map((p) => [p.id, p as PanelInstance])),
    panelIds: panes.map((p) => p.id),
  });
}

afterEach(() => {
  cleanup();
  dispatchMock.mockClear();
  getInfoMock.mockReset();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("isAccountSwitchCandidate (#16136)", () => {
  it("takes a live pane of the agent on another account, or on the default login", () => {
    expect(isAccountSwitchCandidate(pane(), "claude", "company")).toBe(true);
    expect(isAccountSwitchCandidate(pane({ agentAccountId: "company" }), "claude", null)).toBe(
      true
    );
  });

  it.each([
    ["another agent", { launchAgentId: "codex" }],
    ["a pane already on the account", { agentAccountId: "company" }],
    ["a pane now running another agent's CLI", { detectedAgentId: "codex" }],
    ["an exited agent", { agentState: "exited" }],
    ["an agent that left an exit code", { exitCode: 1 }],
    ["a pane in the trash", { location: "trash" }],
    ["a pane already restarting", { isRestarting: true }],
    ["a pane held for recovery", { restoreRecovery: { reason: "session-unresolved" } }],
  ] satisfies [string, PaneOverrides][])("leaves out %s", (_label, overrides) => {
    expect(isAccountSwitchCandidate(pane(overrides), "claude", "company")).toBe(false);
  });
});

describe("readUsageLimitedPaneIds (#16136)", () => {
  it("keeps the candidates whose host remembers a limit, in every worktree", async () => {
    seed([
      pane({ id: "limited", worktreeId: "wt-1" }),
      pane({ id: "limited-elsewhere", worktreeId: "wt-2" }),
      pane({ id: "working-fine" }),
      pane({ id: "on-company", agentAccountId: "company" }),
      pane({ id: "codex", launchAgentId: "codex" }),
      pane({ id: "unreachable" }),
    ]);
    getInfoMock.mockImplementation(async (id: string) => {
      if (id === "unreachable") throw new Error("Terminal unreachable not found");
      const limited = id !== "working-fine";
      return { id, hasPty: true, ...(limited ? { usageLimitObservedAt: 1 } : {}) };
    });

    await expect(readUsageLimitedPaneIds("claude", "company")).resolves.toEqual([
      "limited",
      "limited-elsewhere",
    ]);
    // Only this agent's panes off the account are asked about.
    expect(getInfoMock.mock.calls.map(([id]) => id)).toEqual([
      "limited",
      "limited-elsewhere",
      "working-fine",
      "unreachable",
    ]);
  });

  it("leaves out a pane whose PTY is gone, whatever it last showed", async () => {
    seed([pane({ id: "gone" })]);
    getInfoMock.mockResolvedValue({ id: "gone", hasPty: false, usageLimitObservedAt: 1 });
    await expect(readUsageLimitedPaneIds("claude", "company")).resolves.toEqual([]);
  });
});

describe("AccountSwitchDialog (#16136)", () => {
  const notice: AccountSwitchNoticeState = {
    agentId: "claude",
    account: { id: "company", name: "Company" },
    paneIds: ["a", "b", "c"],
  };

  function renderDialog(onClose = vi.fn(), overrides: Record<string, PaneOverrides> = {}) {
    seed([
      pane({ id: "a", title: "Parser", ...overrides.a }),
      pane({ id: "b", title: "Docs", ...overrides.b }),
      pane({ id: "c", title: "Release", ...overrides.c }),
    ]);
    // The host still remembers each pane's limit when the confirm asks again.
    getInfoMock.mockImplementation(async (id: string) => ({
      id,
      hasPty: true,
      usageLimitObservedAt: 1,
    }));
    const request = buildAccountSwitchRequest(notice, notice.paneIds);
    render(<AccountSwitchDialog request={request} onClose={onClose} />);
    return onClose;
  }

  it("names every pane, checked, and switches all of them on one confirm", async () => {
    const onClose = renderDialog();

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
    expect(screen.getByText("Restart 3 panes on 'Company'?")).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart 3 panes" }));
    });

    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(3));
    expect(dispatchMock.mock.calls).toEqual(
      ["a", "b", "c"].map((terminalId) => [
        "terminal.restartOnAccount",
        { terminalId, accountId: "company", confirmed: true },
        { source: "user" },
      ])
    );
  });

  it("switches only the panes left checked", async () => {
    renderDialog();

    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Parser" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Release" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart pane" }));
    });

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(dispatchMock.mock.calls.map((call) => call[1])).toEqual([
      { terminalId: "b", accountId: "company", confirmed: true },
    ]);
  });

  it("leaves out a pane that worked again before the confirm", async () => {
    renderDialog();
    getInfoMock.mockImplementation(async (id: string) => ({
      id,
      hasPty: true,
      ...(id === "b" ? {} : { usageLimitObservedAt: 1 }),
    }));

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart 3 panes" }));
    });

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(2));
    expect(dispatchMock.mock.calls.map((call) => call[1].terminalId)).toEqual(["a", "c"]);
  });

  it("warns about the checked agents at work, as they are now", () => {
    renderDialog(vi.fn(), { b: { agentState: "working" } });
    expect(screen.getByText(/1 agent is working and will be interrupted/)).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Docs" }));
    });
    expect(screen.queryByText(/will be interrupted/)).toBeNull();
  });

  it("switches nothing with every pane unchecked", () => {
    renderDialog();

    act(() => {
      for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    });
    const confirm = screen.getByRole("button", { name: "Restart 0 panes" });
    expect(
      confirm.hasAttribute("disabled") || confirm.getAttribute("aria-disabled") === "true"
    ).toBe(true);
    act(() => {
      fireEvent.click(confirm);
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("moves panes to the default login with a null account", async () => {
    seed([pane({ id: "a", title: "Parser", agentAccountId: "company" })]);
    getInfoMock.mockResolvedValue({ id: "a", hasPty: true, usageLimitObservedAt: 1 });
    const request = buildAccountSwitchRequest(
      { agentId: "claude", account: { id: null, name: "Default login" }, paneIds: ["a"] },
      ["a"]
    );
    render(<AccountSwitchDialog request={request} onClose={() => {}} />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart pane" }));
    });

    await waitFor(() =>
      expect(dispatchMock).toHaveBeenCalledWith(
        "terminal.restartOnAccount",
        { terminalId: "a", accountId: null, confirmed: true },
        { source: "user" }
      )
    );
  });
});

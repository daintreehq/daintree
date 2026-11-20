// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

const getInfoMock = vi.hoisted(() => vi.fn());
vi.mock("@/clients/terminalClient", () => ({
  terminalClient: { getInfo: (...args: unknown[]) => getInfoMock(...args) },
}));

const worktreeNames = vi.hoisted(() => new Map<string, { name: string }>());
vi.mock("@/store/createWorktreeStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/createWorktreeStore")>()),
  getCurrentViewStoreOrNull: () => ({ getState: () => ({ worktrees: worktreeNames }) }),
}));

import {
  AccountSwitchDialog,
  MoveTerminalsToAccountDialog,
  buildAccountSwitchRequest,
  isAccountSwitchCandidate,
  readUsageLimitedPaneIds,
  type AccountSwitchNoticeState,
} from "../AccountSwitchNotice";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { usePanelStore } from "@/store/panelStore";
import type { AgentSettings } from "@shared/types";
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
  worktreeNames.clear();
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

  let seeded: PtyPanelData[] = [];

  const paneBoxes = () =>
    within(screen.getByTestId("account-switch-panes")).getAllByRole("checkbox");

  /** Changes one seeded pane in place, with the dialog already open. */
  function reseed(id: string, overrides: PaneOverrides) {
    seeded = seeded.map((p) => (p.id === id ? { ...p, ...overrides } : p));
    act(() => seed(seeded));
  }

  function renderDialog(onClose = vi.fn()) {
    seeded = [
      pane({ id: "a", title: "Parser" }),
      pane({ id: "b", title: "Docs" }),
      pane({ id: "c", title: "Release" }),
    ];
    seed(seeded);
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

    const boxes = paneBoxes();
    expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
    expect(screen.getByText("Restart 3 terminals on 'Company'?")).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart 3 terminals" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Restart 3 terminals" }));
    });

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(2));
    expect(dispatchMock.mock.calls.map((call) => call[1].terminalId)).toEqual(["a", "c"]);
  });

  it("warns about the checked agents at work, as they are now", () => {
    renderDialog();
    expect(screen.queryByText(/will be interrupted/)).toBeNull();

    reseed("b", { agentState: "working" });
    expect(screen.getByText(/1 agent is working and will be interrupted/)).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Docs" }));
    });
    expect(screen.queryByText(/will be interrupted/)).toBeNull();
    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Docs" }));
    });
    reseed("b", { agentState: "waiting" });
    expect(screen.queryByText(/will be interrupted/)).toBeNull();
  });

  it("restarts no pane trashed while the host was asked again", async () => {
    renderDialog();
    let answer: () => void = () => {};
    getInfoMock.mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          answer = () => resolve({ id, hasPty: true, usageLimitObservedAt: 1 });
        })
    );
    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Parser" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Release" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
    });

    reseed("b", { location: "trash" });
    await act(async () => answer());

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("switches nothing with every pane unchecked", () => {
    renderDialog();

    act(() => {
      for (const box of paneBoxes()) fireEvent.click(box);
    });
    const confirm = screen.getByRole("button", { name: "Restart 0 terminals" });
    expect(
      confirm.hasAttribute("disabled") || confirm.getAttribute("aria-disabled") === "true"
    ).toBe(true);
    act(() => {
      fireEvent.click(confirm);
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("keeps every chosen pane's conversation with the one box checked (#17088)", async () => {
    renderDialog();

    const keep = screen.getByRole("checkbox", { name: "Keep their conversations" });
    expect(keep.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/starts a new conversation/)).toBeTruthy();

    act(() => {
      fireEvent.click(keep);
      fireEvent.click(screen.getByRole("checkbox", { name: "Docs" }));
    });
    expect(screen.queryByText(/starts a new conversation/)).toBeNull();
    expect(screen.getByText(/reopens its conversation/)).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart 2 terminals" }));
    });

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(2));
    expect(dispatchMock.mock.calls.map((call) => call[1])).toEqual(
      ["a", "c"].map((terminalId) => ({
        terminalId,
        accountId: "company",
        confirmed: true,
        keepConversation: true,
      }))
    );
  });

  it("still keeps the conversations once the dialog has closed and the host answered", async () => {
    seeded = [pane({ id: "a", title: "Parser" }), pane({ id: "b", title: "Docs" })];
    seed(seeded);
    let answer: () => void = () => {};
    getInfoMock.mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          const previous = answer;
          answer = () => {
            previous();
            resolve({ id, hasPty: true, usageLimitObservedAt: 1 });
          };
        })
    );
    const request = buildAccountSwitchRequest(notice, ["a", "b"]);
    const view = render(<AccountSwitchDialog request={request} onClose={() => {}} />);
    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Keep their conversations" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart 2 terminals" }));
    });
    view.rerender(<AccountSwitchDialog request={null} onClose={() => {}} />);

    await act(async () => answer());

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(2));
    expect(dispatchMock.mock.calls.every((call) => call[1].keepConversation === true)).toBe(true);
  });

  it("uses the single-pane keep wording when only one pane is left checked", () => {
    renderDialog();

    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Keep their conversations" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Parser" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Docs" }));
    });
    expect(screen.getByText(/reopens this conversation/)).toBeTruthy();
    // The box names the list it was offered for, not the panes still checked.
    expect(screen.getByRole("checkbox", { name: "Keep their conversations" })).toBeTruthy();
  });

  it("names one pane's conversation when the list holds one pane", () => {
    seed([pane({ id: "a", title: "Parser" })]);
    render(
      <AccountSwitchDialog request={buildAccountSwitchRequest(notice, ["a"])} onClose={() => {}} />
    );
    const keep = screen.getByRole("checkbox", { name: "Keep this conversation" });
    expect(screen.getByText(/starts a new conversation/)).toBeTruthy();
    act(() => {
      fireEvent.click(keep);
    });
    expect(screen.getByText(/reopens this conversation/)).toBeTruthy();
    act(() => {
      fireEvent.click(keep);
    });
    expect(screen.getByText(/starts a new conversation/)).toBeTruthy();
  });

  it("offers no keep box for an agent whose refusal isn't recognised", async () => {
    seed([pane({ id: "a", title: "Parser", launchAgentId: "goose" })]);
    getInfoMock.mockResolvedValue({ id: "a", hasPty: true, usageLimitObservedAt: 1 });
    const request = buildAccountSwitchRequest({ ...notice, agentId: "goose", paneIds: ["a"] }, [
      "a",
    ]);
    render(<AccountSwitchDialog request={request} onClose={() => {}} />);

    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
    });

    await waitFor(() =>
      expect(dispatchMock).toHaveBeenCalledWith(
        "terminal.restartOnAccount",
        { terminalId: "a", accountId: "company", confirmed: true },
        { source: "user" }
      )
    );
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
      fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
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

describe("MoveTerminalsToAccountDialog (#17089)", () => {
  const COMPANY = { id: "company", name: "Company" };
  const PERSONAL = { id: "personal", name: "Personal" };
  let seeded: PtyPanelData[] = [];

  function reseed(id: string, overrides: PaneOverrides) {
    seeded = seeded.map((p) => (p.id === id ? { ...p, ...overrides } : p));
    act(() => seed(seeded));
  }

  function renderMove(account: { id: string | null; name: string } | undefined, onClose = vi.fn()) {
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          claude: {
            accounts: [
              { ...COMPANY, configDir: "/Users/me/.claude-company" },
              { ...PERSONAL, configDir: "/Users/me/.claude-personal" },
            ],
          },
        },
      } satisfies AgentSettings,
    });
    worktreeNames.set("wt-1", { name: "main" });
    worktreeNames.set("wt-2", { name: "feat/parser" });
    seeded = [
      pane({ id: "a", title: "Parser", worktreeId: "wt-2", agentState: "waiting" }),
      pane({ id: "b", title: "Docs", worktreeId: "wt-1", agentState: "working" }),
      pane({ id: "c", title: "Release", worktreeId: "wt-2", agentState: "idle" }),
      pane({ id: "d", title: "On company", agentAccountId: "company" }),
      pane({ id: "e", title: "Codex", launchAgentId: "codex" }),
    ];
    seed(seeded);
    render(<MoveTerminalsToAccountDialog agentId="claude" account={account} onClose={onClose} />);
    return onClose;
  }

  const checked = (name: string) =>
    screen.getByRole("checkbox", { name }).getAttribute("aria-checked");

  it("lists every running terminal of the agent by worktree, limited or not, a working one unchecked", () => {
    renderMove(COMPANY);

    const groups = screen.getAllByRole("group");
    expect(groups.map((group) => group.textContent)).toEqual([
      "feat/parserParserRelease",
      "mainDocs",
    ]);
    expect(
      within(groups[0]!)
        .getAllByRole("checkbox")
        .map((box) => box.getAttribute("aria-checked"))
    ).toEqual(["true", "true"]);
    expect(checked("Docs")).toBe("false");
    expect(screen.getByText("Restart 2 terminals on 'Company'?")).toBeTruthy();
    expect(screen.queryByText(/will be interrupted/)).toBeNull();
  });

  it("follows a rename made while it's open, keeping the account and the boxes as they were (#17080)", () => {
    renderMove(COMPANY);
    fireEvent.click(screen.getByRole("checkbox", { name: "Release" }));
    expect(screen.getByText("Restart 1 terminal on 'Company'?")).toBeTruthy();

    // Company becomes Acme, and Personal takes the old name.
    act(() => {
      useAgentSettingsStore.setState({
        settings: {
          agents: {
            claude: {
              accounts: [
                { id: "company", name: "Acme", configDir: "/Users/me/.claude-company" },
                { id: "personal", name: "Company", configDir: "/Users/me/.claude-personal" },
              ],
            },
          },
        },
      });
    });

    expect(screen.getByText("Restart 1 terminal on 'Acme'?")).toBeTruthy();
    expect(checked("Release")).toBe("false");
    expect(checked("Parser")).toBe("true");
  });

  it("restarts exactly the checked terminals, without asking the host about limits", async () => {
    const onClose = renderMove(COMPANY);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart 2 terminals" }));
    });

    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(2));
    expect(dispatchMock.mock.calls).toEqual(
      ["a", "c"].map((terminalId) => [
        "terminal.restartOnAccount",
        { terminalId, accountId: "company", confirmed: true },
        { source: "user" },
      ])
    );
    expect(getInfoMock).not.toHaveBeenCalled();
  });

  it("restarts the boxes as left, a ticked working agent included", async () => {
    renderMove(COMPANY);

    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Parser" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Docs" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart 2 terminals" }));
    });

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(2));
    expect(dispatchMock.mock.calls.map((call) => call[1].terminalId)).toEqual(["b", "c"]);
    expect(getInfoMock).not.toHaveBeenCalled();
  });

  it("asks for an account again once the picked one is removed", () => {
    renderMove(COMPANY);
    expect(screen.getByText("Restart 2 terminals on 'Company'?")).toBeTruthy();

    act(() => {
      useAgentSettingsStore.setState({
        settings: {
          agents: {
            claude: {
              accounts: [{ ...PERSONAL, configDir: "/Users/me/.claude-personal" }],
            },
          },
        } satisfies AgentSettings,
      });
    });

    expect(screen.getByText("Move Claude terminals to which account?")).toBeTruthy();
    expect(screen.queryByTestId("account-switch-panes")).toBeNull();
    const confirm = screen.getByRole("button", { name: "Restart 0 terminals" });
    expect(
      confirm.hasAttribute("disabled") || confirm.getAttribute("aria-disabled") === "true"
    ).toBe(true);
  });

  it("calls out a working agent once it is ticked", () => {
    renderMove(COMPANY);

    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Docs" }));
    });
    expect(screen.getByText(/1 agent is working and will be interrupted/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart 3 terminals" })).toBeTruthy();
  });

  it("leaves out a terminal trashed before the confirm", async () => {
    renderMove(COMPANY);
    reseed("a", { location: "trash" });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart 2 terminals" }));
    });

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(dispatchMock.mock.calls[0]![1]).toEqual({
      terminalId: "c",
      accountId: "company",
      confirmed: true,
    });
  });

  it("asks for the account first when the palette opened it, then lists that account's terminals", () => {
    renderMove(undefined);

    expect(screen.getByText("Move Claude terminals to which account?")).toBeTruthy();
    expect(screen.queryByTestId("account-switch-panes")).toBeNull();
    const confirm = screen.getByRole("button", { name: "Restart 0 terminals" });
    expect(
      confirm.hasAttribute("disabled") || confirm.getAttribute("aria-disabled") === "true"
    ).toBe(true);

    const picker = screen.getByRole("combobox", { name: "Account" });
    act(() => {
      fireEvent.keyDown(picker, { key: "ArrowDown" });
    });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Default login",
      "Company",
      "Personal",
    ]);
    act(() => {
      fireEvent.keyDown(screen.getByRole("option", { name: "Default login" }), { key: "Enter" });
    });

    // Every pane here is on the default login but the one on Company.
    expect(screen.getByText("Restart 1 terminal on 'Default login'?")).toBeTruthy();
    expect(
      within(screen.getByTestId("account-switch-panes")).getAllByRole("checkbox")
    ).toHaveLength(1);
    expect(checked("On company")).toBe("true");
  });

  it("starts the boxes afresh for another account", () => {
    renderMove(COMPANY);
    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Parser" }));
    });
    expect(checked("Parser")).toBe("false");

    act(() => {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Account" }), { key: "ArrowDown" });
    });
    act(() => {
      fireEvent.keyDown(screen.getByRole("option", { name: "Personal" }), { key: "Enter" });
    });

    expect(checked("Parser")).toBe("true");
    expect(checked("On company")).toBe("true");
    expect(screen.getByText("Restart 3 terminals on 'Personal'?")).toBeTruthy();
  });

  it("says so when no terminal can move to the account", () => {
    renderMove(COMPANY);
    cleanup();
    seed([pane({ id: "d", title: "On company", agentAccountId: "company" })]);
    render(<MoveTerminalsToAccountDialog agentId="claude" account={COMPANY} onClose={() => {}} />);

    expect(screen.getByText("Move Claude terminals to 'Company'?")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "No running Claude terminal to move to Company"
    );
    const confirm = screen.getByRole("button", { name: "Restart 0 terminals" });
    expect(
      confirm.hasAttribute("disabled") || confirm.getAttribute("aria-disabled") === "true"
    ).toBe(true);
  });
});

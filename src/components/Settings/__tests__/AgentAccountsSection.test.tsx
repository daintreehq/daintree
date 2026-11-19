// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const dispatch = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

// The confirm asks the host again before it restarts anything (#16136).
vi.mock("@/clients/terminalClient", () => ({
  terminalClient: {
    getInfo: async (id: string) => ({ id, hasPty: true, usageLimitObservedAt: 1 }),
  },
}));

// The host's answer to which panes are stopped on a usage limit (#16136).
const readUsageLimitedPaneIds = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("@/components/Layout/AccountSwitchNotice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Layout/AccountSwitchNotice")>()),
  readUsageLimitedPaneIds,
}));

// The confirm itself is covered with the dialog; here only which account the row opens it on.
const everywhereDialog = vi.hoisted(() => ({
  props: null as null | {
    account?: { id: string | null; name: string };
    onSaved?: () => void;
    onClose: () => void;
  },
}));
vi.mock("@/components/Layout/UseAccountEverywhereDialog", () => ({
  UseAccountEverywhereDialog: (props: NonNullable<typeof everywhereDialog.props>) => {
    everywhereDialog.props = props;
    return <div data-testid="use-everywhere-dialog" />;
  },
}));

// The reading itself is covered with the hook; here only what the row asks of it.
const headroomHook = vi.hoisted(() => ({
  calls: [] as Array<[string | undefined, boolean]>,
  texts: new Map<string, string>(),
}));
vi.mock("@/hooks/useAgentAccountHeadroom", () => ({
  useAgentAccountHeadroom: (agentId: string | undefined, open: boolean) => {
    headroomHook.calls.push([agentId, open]);
    return (target: { kind: string; accountId?: string }) => {
      const text = headroomHook.texts.get(target.accountId ?? "default");
      return text ? { text, stale: false } : undefined;
    };
  },
}));

// A native select in place of the Radix one, which jsdom can't open (focus
// stands for opening it); the reset button stays, as the real row draws it.
vi.mock("@/components/Settings/SettingsSelect", () => ({
  SettingsSelect: ({
    label,
    description,
    value,
    onValueChange,
    options,
    isModified,
    onReset,
    resetAriaLabel,
    onOpenChange,
  }: {
    label: string;
    description?: string;
    value: string;
    onValueChange: (value: string) => void;
    options: { value: string; label: string; description?: string }[];
    isModified?: boolean;
    onReset?: () => void;
    resetAriaLabel?: string;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onFocus={() => onOpenChange?.(true)}
        onBlur={() => onOpenChange?.(false)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {options.map(
        (option) =>
          option.description && (
            <p key={option.value} data-testid={`option-description-${option.value}`}>
              {option.description}
            </p>
          )
      )}
      {description && <p>{description}</p>}
      {isModified && onReset && (
        <button type="button" aria-label={resetAriaLabel} onClick={onReset}>
          Reset
        </button>
      )}
    </div>
  ),
}));

import { AgentAccountsSection } from "../AgentAccountsSection";
import { SettingsFlushContext } from "../SettingsFlushRegistry";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { usePanelStore } from "@/store/panelStore";
import type { AgentSettingsEntry } from "@shared/types";
import type { PtyPanelData } from "@shared/types/panel";

const COMPANY = { id: "company", name: "Company", configDir: "/Users/me/.codex-company" };
const PERSONAL = { id: "personal", name: "Personal", configDir: "/Users/me/.codex-personal" };

function renderSection(
  entry: AgentSettingsEntry,
  options: {
    agentId?: string;
    onClose?: (afterClose?: (closed: boolean) => void) => Promise<boolean>;
  } = {}
) {
  return render(
    <AgentAccountsSection
      agentId={options.agentId ?? "codex"}
      agentName="Codex"
      entry={entry}
      onClose={options.onClose}
    />
  );
}

beforeEach(() => {
  headroomHook.calls.length = 0;
  headroomHook.texts.clear();
  dispatch.mockClear();
  readUsageLimitedPaneIds.mockReset();
  readUsageLimitedPaneIds.mockResolvedValue([]);
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AgentAccountsSection (#16040)", () => {
  it.each(["cursor", "gemini", "amp"])(
    "renders nothing for %s, whose login no account folder can hold",
    (agentId) => {
      const { container } = renderSection({}, { agentId });
      expect(container.innerHTML).toBe("");
    }
  );

  it("offers the add action in the empty list, and no default to choose yet", () => {
    renderSection({});
    expect(screen.getByText(/Add an account to run Codex on another login/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add account" })).toHaveLength(1);
    expect(screen.queryByText("Default account")).toBeNull();
  });

  it("reads quota for the default account's list only while it is open, and shows each login's window (#16407)", () => {
    headroomHook.texts.set("default", "5-hour limit 10% used");
    headroomHook.texts.set("company", "Weekly limit 82% used");
    renderSection({ accounts: [COMPANY] });
    expect(headroomHook.calls.every(([, open]) => !open)).toBe(true);

    const select = screen.getByRole("combobox", { name: "Default account" });
    fireEvent.focus(select);
    expect(headroomHook.calls.at(-1)).toEqual(["codex", true]);
    expect(screen.getByTestId("option-description-default-login").textContent).toBe(
      "5-hour limit 10% used"
    );
    expect(screen.getByTestId("option-description-company").textContent).toBe(
      "Weekly limit 82% used"
    );

    fireEvent.blur(select);
    expect(headroomHook.calls.at(-1)).toEqual(["codex", false]);
  });

  it("closes Settings before it opens the sign-in terminal on the account", async () => {
    let afterClose: ((closed: boolean) => void) | undefined;
    const onClose = vi.fn(async (callback?: (closed: boolean) => void) => {
      afterClose = callback;
      return true;
    });
    renderSection({ accounts: [COMPANY] }, { onClose });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await act(async () => {});
    expect(dispatch).not.toHaveBeenCalled();

    afterClose?.(true);
    expect(dispatch).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "codex", accountId: "company", presetId: null },
      { source: "user" }
    );
  });

  it("doesn't open the terminal when the close is held", async () => {
    // A held close answers false and never calls back (SettingsTabClose).
    const onClose = vi.fn(async () => false);
    renderSection({ accounts: [COMPANY] }, { onClose });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await act(async () => {});
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("shows a saved default whose account is gone as changed, and resets it", async () => {
    const updateAgent = vi.fn().mockResolvedValue(undefined);
    useAgentSettingsStore.setState({ updateAgent });
    renderSection({ accounts: [], accountId: "gone" });

    expect(screen.getByText(/launches are refused until this is reset/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use Codex's default login" }));
    await act(async () => {});

    expect(updateAgent).toHaveBeenCalledWith("codex", { accountId: undefined });
  });

  it("says a preset's pin wins over the default too", () => {
    renderSection({ accounts: [COMPANY] });
    expect(
      screen.getByText(
        "What a new launch signs in as, unless its worktree picks another in the toolbar or its preset pins one"
      )
    ).toBeTruthy();
  });

  describe("using one account everywhere (#17893)", () => {
    beforeEach(() => {
      everywhereDialog.props = null;
    });

    const open = () => fireEvent.click(screen.getByRole("button", { name: "Use everywhere…" }));

    it("opens on the saved default, or the default login when none is saved", () => {
      renderSection({ accounts: [PERSONAL, COMPANY], accountId: "company" });
      expect(screen.queryByTestId("use-everywhere-dialog")).toBeNull();
      open();
      expect(everywhereDialog.props?.account).toEqual({ id: "company", name: "Company" });

      cleanup();
      renderSection({ accounts: [COMPANY], defaultLoginName: "Home" });
      open();
      expect(everywhereDialog.props?.account).toEqual({
        id: null,
        name: "Home · default login",
      });
    });

    it("leaves the account to the dialog when the saved default is gone", () => {
      renderSection({ accounts: [], accountId: "gone" });
      open();
      expect(screen.getByTestId("use-everywhere-dialog")).toBeTruthy();
      expect(everywhereDialog.props?.account).toBeUndefined();

      cleanup();
      renderSection({ accounts: [COMPANY], accountId: "gone" });
      open();
      expect(everywhereDialog.props?.account).toBeUndefined();
    });

    it("is offered when only a worktree pick or preset pin names an account that's gone", () => {
      renderSection({ worktreeAccounts: { "/work/app/main": "gone" } });
      open();
      expect(everywhereDialog.props?.account).toEqual({ id: null, name: "Default login" });

      cleanup();
      renderSection({ customPresets: [{ id: "review", name: "Review", accountId: "gone" }] });
      expect(screen.getByRole("button", { name: "Use everywhere…" })).toBeTruthy();

      cleanup();
      // On the default login already: nothing for the action to reach.
      renderSection({ worktreeAccounts: { "/work/app/main": null } });
      expect(screen.queryByRole("button", { name: "Use everywhere…" })).toBeNull();
    });

    it("drops an offer the Default account select raised once the change is saved", async () => {
      usePanelStore.setState({
        panelsById: {
          p1: {
            id: "p1",
            kind: "terminal",
            title: "Parser",
            cwd: "/repo",
            cols: 80,
            rows: 24,
            location: "grid",
            launchAgentId: "codex",
            agentState: "waiting",
          } as PtyPanelData,
        },
        panelIds: ["p1"],
      });
      readUsageLimitedPaneIds.mockResolvedValue(["p1"]);
      useAgentSettingsStore.setState({ updateAgent: vi.fn().mockResolvedValue(undefined) });
      renderSection({ accounts: [COMPANY] });
      await act(async () => {
        fireEvent.change(screen.getByRole("combobox", { name: "Default account" }), {
          target: { value: "company" },
        });
      });
      expect(screen.getByRole("status").textContent).toBe(
        "1 Codex terminal stopped on a usage limit"
      );

      open();
      act(() => everywhereDialog.props?.onSaved?.());
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("tells Settings once the change is saved, and closes on the dialog's word", () => {
      const onSettingsChange = vi.fn();
      render(
        <AgentAccountsSection
          agentId="codex"
          agentName="Codex"
          entry={{ accounts: [COMPANY] }}
          onSettingsChange={onSettingsChange}
        />
      );
      open();
      expect(onSettingsChange).not.toHaveBeenCalled();
      act(() => everywhereDialog.props?.onSaved?.());
      expect(onSettingsChange).toHaveBeenCalledTimes(1);
      act(() => everywhereDialog.props?.onClose());
      expect(screen.queryByTestId("use-everywhere-dialog")).toBeNull();
    });

    it("isn't offered until there's an account, or a saved default, to use", () => {
      renderSection({});
      expect(screen.queryByRole("button", { name: "Use everywhere…" })).toBeNull();
    });
  });

  it("asks before forgetting an account, then removes it", async () => {
    const removeAccount = vi.fn().mockResolvedValue(undefined);
    useAgentSettingsStore.setState({ removeAccount });
    renderSection({ accounts: [COMPANY] });

    fireEvent.click(screen.getByRole("button", { name: "Remove Company" }));
    expect(removeAccount).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Remove account" }));
    await act(async () => {});

    expect(removeAccount).toHaveBeenCalledWith("codex", "company");
  });

  describe("focus after the remove confirmation", () => {
    // Initial focus lands on Cancel a frame after the confirm mounts; waiting
    // for it means a later check sees the restore, not focus never having left.
    async function openConfirm(remove: HTMLElement) {
      remove.focus();
      fireEvent.click(remove);
      const cancel = await screen.findByRole("button", { name: "Cancel" });
      await waitFor(() => expect(document.activeElement).toBe(cancel));
    }

    it("goes to Add account once a removal is confirmed, and back to the row on cancel", async () => {
      // Still saving: the row, and the button that opened the confirm, stay put.
      const removeAccount = vi.fn(() => new Promise<void>(() => {}));
      useAgentSettingsStore.setState({ removeAccount });
      renderSection({ accounts: [COMPANY] });
      const remove = screen.getByRole("button", { name: "Remove Company" });

      await openConfirm(remove);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(document.activeElement).toBe(remove));

      await openConfirm(remove);
      fireEvent.click(screen.getByRole("button", { name: "Remove account" }));
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add account" }))
      );

      // Reopened, a cancel is a cancel again, not the last confirmation.
      await openConfirm(remove);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(document.activeElement).toBe(remove));
    });

    it("follows Add account into the empty row when the last removal saves after the confirm closed", async () => {
      let finishSave: () => void = () => {};
      const removeAccount = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve;
          })
      );
      useAgentSettingsStore.setState({ removeAccount });
      const view = renderSection({ accounts: [COMPANY] });

      await openConfirm(screen.getByRole("button", { name: "Remove Company" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove account" }));
      const headingAdd = screen.getByRole("button", { name: "Add account" });
      await waitFor(() => expect(document.activeElement).toBe(headingAdd));

      await act(async () => finishSave());
      view.rerender(
        <AgentAccountsSection agentId="codex" agentName="Codex" entry={{ accounts: [] }} />
      );

      const emptyRowAdd = screen.getByRole("button", { name: "Add account" });
      expect(emptyRowAdd).not.toBe(headingAdd);
      expect(document.activeElement).toBe(emptyRowAdd);
    });
  });

  describe("offering the panes stopped on a usage limit (#16136)", () => {
    const limitedPane: PtyPanelData = {
      id: "p1",
      kind: "terminal",
      title: "Parser",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      location: "grid",
      launchAgentId: "codex",
      agentState: "waiting",
    };

    beforeEach(() => {
      usePanelStore.setState({ panelsById: { p1: limitedPane }, panelIds: ["p1"] });
      readUsageLimitedPaneIds.mockResolvedValue(["p1"]);
    });

    it("offers them under a new default account, and switches the ones confirmed", async () => {
      const updateAgent = vi.fn().mockResolvedValue(undefined);
      useAgentSettingsStore.setState({ updateAgent });
      renderSection({ accounts: [COMPANY] });

      await act(async () => {
        fireEvent.change(screen.getByRole("combobox", { name: "Default account" }), {
          target: { value: "company" },
        });
      });

      expect(updateAgent).toHaveBeenCalledWith("codex", { accountId: "company" });
      expect(readUsageLimitedPaneIds).toHaveBeenCalledWith("codex", "company");
      expect(screen.getByRole("status").textContent).toBe(
        "1 Codex terminal stopped on a usage limit"
      );

      fireEvent.click(screen.getByRole("button", { name: "Switch it to Company…" }));
      expect(screen.getByText("Restart 1 terminal on 'Company'?")).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
      });

      await waitFor(() =>
        expect(dispatch).toHaveBeenCalledWith(
          "terminal.restartOnAccount",
          { terminalId: "p1", accountId: "company", confirmed: true },
          { source: "user" }
        )
      );
    });

    it("offers a move to the default login when the default is reset", async () => {
      useAgentSettingsStore.setState({ updateAgent: vi.fn().mockResolvedValue(undefined) });
      usePanelStore.setState({
        panelsById: { p1: { ...limitedPane, agentAccountId: "company" } },
        panelIds: ["p1"],
      });
      renderSection({ accounts: [COMPANY], accountId: "company" });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Use Codex's default login" }));
      });

      expect(readUsageLimitedPaneIds).toHaveBeenCalledWith("codex", null);
      expect(screen.getByRole("button", { name: "Switch it to Default login…" })).toBeTruthy();
    });

    it("offers a move off a saved default whose account is gone", async () => {
      useAgentSettingsStore.setState({ updateAgent: vi.fn().mockResolvedValue(undefined) });
      usePanelStore.setState({
        panelsById: { p1: { ...limitedPane, agentAccountId: "gone" } },
        panelIds: ["p1"],
      });
      renderSection({ accounts: [COMPANY], accountId: "gone" });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Use Codex's default login" }));
      });

      expect(screen.getByRole("button", { name: "Switch it to Default login…" })).toBeTruthy();
    });

    it("keeps the offer of the later change when an earlier save lands last", async () => {
      const LAB = { id: "lab", name: "Lab", configDir: "/Users/me/.codex-lab" };
      let finishFirst: () => void = () => {};
      const updateAgent = vi
        .fn()
        .mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)))
        .mockResolvedValue(undefined);
      useAgentSettingsStore.setState({ updateAgent });
      renderSection({ accounts: [COMPANY, LAB] });
      const select = screen.getByRole("combobox", { name: "Default account" });

      fireEvent.change(select, { target: { value: "company" } });
      await act(async () => {
        fireEvent.change(select, { target: { value: "lab" } });
      });
      await act(async () => finishFirst());

      expect(screen.getByRole("button", { name: "Switch it to Lab…" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Switch it to Company…" })).toBeNull();
    });

    it("leaves them alone with Keep", async () => {
      useAgentSettingsStore.setState({ updateAgent: vi.fn().mockResolvedValue(undefined) });
      renderSection({ accounts: [COMPANY] });
      await act(async () => {
        fireEvent.change(screen.getByRole("combobox", { name: "Default account" }), {
          target: { value: "company" },
        });
      });

      fireEvent.click(screen.getByRole("button", { name: "Keep" }));

      expect(screen.queryByRole("status")).toBeNull();
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("offers them when an existing, signed-in folder is added", async () => {
      const addAccount = vi.fn().mockResolvedValue(COMPANY);
      useAgentSettingsStore.setState({ addAccount });
      renderSection({});

      fireEvent.click(screen.getByRole("button", { name: "Add account" }));
      fireEvent.change(screen.getByTestId("add-account-name"), { target: { value: "Company" } });
      fireEvent.click(screen.getByLabelText("Use an existing folder"));
      fireEvent.change(screen.getByTestId("add-account-path"), {
        target: { value: COMPANY.configDir },
      });
      await act(async () => {
        fireEvent.click(screen.getAllByRole("button", { name: "Add account" }).at(-1)!);
      });

      expect(readUsageLimitedPaneIds).toHaveBeenCalledWith("codex", "company");
      expect(screen.getByRole("button", { name: "Switch it to Company…" })).toBeTruthy();
    });

    it("waits on a new folder, which only its sign-in fills", async () => {
      const addAccount = vi.fn().mockResolvedValue(COMPANY);
      useAgentSettingsStore.setState({ addAccount });
      renderSection({});

      fireEvent.click(screen.getByRole("button", { name: "Add account" }));
      fireEvent.change(screen.getByTestId("add-account-name"), { target: { value: "Company" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create and sign in" }));
      });

      expect(readUsageLimitedPaneIds).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "codex", accountId: "company", presetId: null },
        { source: "user" }
      );
    });
  });
});

describe("naming the default login and renaming accounts (#17080)", () => {
  function editField(rename: HTMLElement, value: string): HTMLInputElement {
    fireEvent.click(rename);
    const input = document.activeElement as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    fireEvent.change(input, { target: { value } });
    return input;
  }

  it("lists the default login with its folder even before any account, and names it by id", async () => {
    const renameAccount = vi.fn().mockResolvedValue(undefined);
    useAgentSettingsStore.setState({ renameAccount });
    renderSection({});

    expect(screen.getByText("Default login")).toBeTruthy();
    expect(screen.getByText("~/.codex")).toBeTruthy();
    const rename = screen.getByRole("button", { name: "Rename default login" });
    const input = editField(rename, "  Work ");
    expect(screen.getByRole("textbox", { name: "Default login name" })).toBe(input);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(renameAccount).toHaveBeenCalledTimes(1);
    expect(renameAccount).toHaveBeenCalledWith("codex", null, "Work");
    // The blur the field's unmount brings doesn't save a second time.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Rename default login" })
    );
  });

  it("shows the name beside the default login in the row and the default account choice, and clears it", async () => {
    const renameAccount = vi.fn().mockResolvedValue(undefined);
    useAgentSettingsStore.setState({ renameAccount });
    renderSection({ accounts: [COMPANY], defaultLoginName: "Work" });

    expect(
      screen.getByText("Work · default login", { selector: "[data-settings-row-label]" })
    ).toBeTruthy();
    const select = screen.getByRole("combobox", { name: "Default account" }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Work · default login",
      "Company",
    ]);

    const input = editField(screen.getByRole("button", { name: "Rename default login" }), "");
    expect(input.placeholder).toBe("Default login");
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(renameAccount).toHaveBeenCalledWith("codex", null, "");
  });

  it("renames a saved account in place, never by removing and adding it", async () => {
    const renameAccount = vi.fn().mockResolvedValue(undefined);
    const removeAccount = vi.fn();
    const addAccount = vi.fn();
    useAgentSettingsStore.setState({ renameAccount, removeAccount, addAccount });
    renderSection({ accounts: [COMPANY] });

    const input = editField(screen.getByRole("button", { name: "Rename Company" }), "Acme");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(renameAccount).toHaveBeenCalledWith("codex", "company", "Acme");
    expect(removeAccount).not.toHaveBeenCalled();
    expect(addAccount).not.toHaveBeenCalled();
  });

  it("keeps a saved account's field open on a blank name, and saves nothing", async () => {
    const renameAccount = vi.fn().mockResolvedValue(undefined);
    useAgentSettingsStore.setState({ renameAccount });
    renderSection({ accounts: [COMPANY] });

    const input = editField(screen.getByRole("button", { name: "Rename Company" }), "  ");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(renameAccount).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Give the account a name");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input);
  });

  it("keeps the draft and says why when the save is refused", async () => {
    const renameAccount = vi
      .fn()
      .mockRejectedValue(new Error("That account isn't saved any more."));
    useAgentSettingsStore.setState({ renameAccount });
    renderSection({ accounts: [COMPANY] });

    const input = editField(screen.getByRole("button", { name: "Rename Company" }), "Acme");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(screen.getByRole("alert").textContent).toBe("That account isn't saved any more.");
    expect((screen.getByRole("textbox", { name: "Account name" }) as HTMLInputElement).value).toBe(
      "Acme"
    );
  });

  it("saves once while a save is in flight, and leaves an unchanged name and Escape unsaved", async () => {
    let finish: () => void = () => {};
    const renameAccount = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    useAgentSettingsStore.setState({ renameAccount });
    renderSection({ accounts: [COMPANY] });

    const input = editField(screen.getByRole("button", { name: "Rename Company" }), "Acme");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(renameAccount).toHaveBeenCalledTimes(1);
    await act(async () => finish());

    renameAccount.mockClear();
    const same = editField(screen.getByRole("button", { name: "Rename Company" }), "Company");
    await act(async () => {
      fireEvent.keyDown(same, { key: "Enter" });
    });
    const cancelled = editField(screen.getByRole("button", { name: "Rename Company" }), "Other");
    fireEvent.keyDown(cancelled, { key: "Escape" });
    expect(renameAccount).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Account name" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename Company" }));
  });
});

describe("renaming against other views and a Settings close (#17080)", () => {
  it("lists the default login first, above the saved accounts", () => {
    renderSection({ accounts: [COMPANY] });
    expect(
      [...document.querySelectorAll("[data-settings-row-label]")].map((label) => label.textContent)
    ).toEqual(["Default login", "Company", "Use one account everywhere"]);
  });

  it("leaves a rename another view made alone when the field is left untouched", async () => {
    const renameAccount = vi.fn().mockResolvedValue(undefined);
    useAgentSettingsStore.setState({ renameAccount });
    const view = renderSection({ accounts: [COMPANY], defaultLoginName: "Work" });
    fireEvent.click(screen.getByRole("button", { name: "Rename default login" }));

    view.rerender(
      <AgentAccountsSection
        agentId="codex"
        agentName="Codex"
        entry={{ accounts: [COMPANY], defaultLoginName: "Team" }}
      />
    );
    await act(async () => {
      fireEvent.blur(screen.getByRole("textbox", { name: "Default login name" }));
    });

    expect(renameAccount).not.toHaveBeenCalled();
  });

  it("clears a refused name's reason once the name changes", async () => {
    renderSection({ accounts: [COMPANY] });
    fireEvent.click(screen.getByRole("button", { name: "Rename Company" }));
    const input = screen.getByRole("textbox", { name: "Account name" });
    fireEvent.change(input, { target: { value: "" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(screen.getByRole("alert")).toBeTruthy();

    fireEvent.change(input, { target: { value: "Acme" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("saves an open edit when Settings closes, and holds the close on the field when the save is refused", async () => {
    const flushers: Array<(reason: "close" | "hide") => unknown> = [];
    const register = vi.fn((_tab: string, fn: (reason: "close" | "hide") => unknown) => {
      flushers.push(fn);
      return () => flushers.splice(flushers.indexOf(fn), 1);
    });
    const renameAccount = vi
      .fn()
      .mockRejectedValueOnce(new Error("This host can't rename accounts yet."))
      .mockResolvedValueOnce(undefined);
    useAgentSettingsStore.setState({ renameAccount });
    render(
      <SettingsFlushContext.Provider value={{ register, flushAll: vi.fn() }}>
        <AgentAccountsSection agentId="codex" agentName="Codex" entry={{ accounts: [COMPANY] }} />
      </SettingsFlushContext.Provider>
    );
    expect(flushers).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Rename Company" }));
    const input = screen.getByRole("textbox", { name: "Account name" });
    fireEvent.change(input, { target: { value: "Acme" } });
    expect(register).toHaveBeenCalledWith("agents", expect.any(Function));

    let failure: unknown;
    await act(async () => {
      failure = await flushers[0]!("close");
    });
    expect(renameAccount).toHaveBeenCalledWith("codex", "company", "Acme");
    // The landing focuses the first field in the element it names: this one.
    const landOn = (failure as { landOn: string }).landOn;
    expect(document.getElementById(landOn)?.querySelector("input")).toBe(input);
    expect(screen.getByRole("alert").textContent).toBe("This host can't rename accounts yet.");

    let saved: unknown;
    await act(async () => {
      saved = await flushers[0]!("close");
    });
    expect(saved).toBeUndefined();
    expect(flushers).toHaveLength(0);
  });

  it("sends a rename once when a close waits on it and another close follows", async () => {
    const flushers: Array<(reason: "close" | "hide") => unknown> = [];
    const register = vi.fn((_tab: string, fn: (reason: "close" | "hide") => unknown) => {
      flushers.push(fn);
      return () => flushers.splice(flushers.indexOf(fn), 1);
    });
    let finish: () => void = () => {};
    const renameAccount = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    useAgentSettingsStore.setState({ renameAccount });
    render(
      <SettingsFlushContext.Provider value={{ register, flushAll: vi.fn() }}>
        <AgentAccountsSection agentId="codex" agentName="Codex" entry={{ accounts: [COMPANY] }} />
      </SettingsFlushContext.Provider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename Company" }));
    const input = screen.getByRole("textbox", { name: "Account name" });
    fireEvent.change(input, { target: { value: "Acme" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const flush = flushers[0]!;

    // A close while the Enter's save is in flight waits on that save.
    let firstResult: unknown = "pending";
    const first = (flush("close") as Promise<unknown>).then((result) => (firstResult = result));
    await act(async () => {});
    expect(firstResult).toBe("pending");
    expect(renameAccount).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await first;
    });
    expect(firstResult).toBeUndefined();

    // A close queued behind it reaches the row before it unregisters.
    expect(renameAccount).toHaveBeenCalledTimes(1);
    await act(async () => {
      await flush("close");
    });
    expect(renameAccount).toHaveBeenCalledTimes(1);
  });

  it("lets a close through an untouched name saved before today's cleaning, and saves a cleanup", async () => {
    const flushers: Array<(reason: "close" | "hide") => unknown> = [];
    const register = vi.fn((_tab: string, fn: (reason: "close" | "hide") => unknown) => {
      flushers.push(fn);
      return () => flushers.splice(flushers.indexOf(fn), 1);
    });
    const renameAccount = vi.fn().mockResolvedValue(undefined);
    useAgentSettingsStore.setState({ renameAccount });
    const marked = { id: "marked", name: "W\u200bork", configDir: "/Users/me/.codex-m" };
    const blank = { id: "blank", name: "\u200b", configDir: "/Users/me/.codex-b" };
    render(
      <SettingsFlushContext.Provider value={{ register, flushAll: vi.fn() }}>
        <AgentAccountsSection
          agentId="codex"
          agentName="Codex"
          entry={{ accounts: [marked, blank] }}
        />
      </SettingsFlushContext.Provider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename \u200b" }));
    let result: unknown = "pending";
    await act(async () => {
      result = await flushers[0]!("close");
    });
    expect(result).toBeUndefined();
    expect(renameAccount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Rename W\u200bork" }));
    const input = screen.getByRole("textbox", { name: "Account name" });
    fireEvent.change(input, { target: { value: "Work" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(renameAccount).toHaveBeenCalledWith("codex", "marked", "Work");
  });
});

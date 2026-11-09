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
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { usePanelStore } from "@/store/panelStore";
import type { AgentSettingsEntry } from "@shared/types";
import type { PtyPanelData } from "@shared/types/panel";

const COMPANY = { id: "company", name: "Company", configDir: "/Users/me/.codex-company" };

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

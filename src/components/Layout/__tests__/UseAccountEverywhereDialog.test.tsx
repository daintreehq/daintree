// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

const listMock = vi.hoisted(() => vi.fn());
vi.mock("@/clients/agentSettingsClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/clients/agentSettingsClient")>();
  return {
    agentSettingsClient: {
      ...original.agentSettingsClient,
      listAccountChoicesAway: (...args: unknown[]) => listMock(...args),
    },
  };
});

vi.mock("@/store/createWorktreeStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/createWorktreeStore")>()),
  getCurrentViewStoreOrNull: () => null,
}));

import { UseAccountEverywhereDialog } from "../UseAccountEverywhereDialog";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { usePanelStore } from "@/store/panelStore";
import type { AgentSettings } from "@shared/types";
import type { AccountChoicesAway } from "@shared/types/ipc/agentAccounts";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

const SPENT = { id: "spent", name: "Spent" };
const FRESH = { id: "fresh", name: "Fresh" };

const LISTED: AccountChoicesAway = {
  worktrees: [
    { worktreeId: "/work/app/main", accountId: "spent", gone: false },
    { worktreeId: "/work/site/old", accountId: null, gone: true },
  ],
  presets: [
    { presetId: "review", presetName: "Review", accountId: "spent" },
    { presetId: "dup", presetName: "Twin", accountId: "spent", sharedId: true },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const applyMock = vi.fn();

function seedPanes(panes: Array<Partial<PtyPanelData>>) {
  const full = panes.map(
    (overrides, index) =>
      ({
        id: `p${index}`,
        kind: "terminal",
        title: `Claude ${index}`,
        cwd: "/work/app",
        cols: 80,
        rows: 24,
        location: "grid",
        launchAgentId: "claude",
        worktreeId: "/work/app/main",
        agentState: "waiting",
        ...overrides,
      }) as PtyPanelData
  );
  usePanelStore.setState({
    panelsById: Object.fromEntries(full.map((p) => [p.id, p as PanelInstance])),
    panelIds: full.map((p) => p.id),
  });
}

function renderDialog(
  account: { id: string | null; name: string } | undefined,
  entry: Record<string, unknown> = { accountId: "spent" }
) {
  useAgentSettingsStore.setState({
    settings: {
      agents: {
        claude: {
          accounts: [
            { ...SPENT, configDir: "/Users/me/.claude-spent" },
            { ...FRESH, configDir: "/Users/me/.claude-fresh" },
          ],
          ...entry,
        },
      },
    } satisfies AgentSettings,
    applyAccountEverywhere: applyMock,
  });
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <UseAccountEverywhereDialog
      agentId="claude"
      account={account}
      onSaved={onSaved}
      onClose={onClose}
    />
  );
  return { onClose, onSaved };
}

const checked = (name: string) =>
  screen.getByRole("checkbox", { name }).getAttribute("aria-checked");
const isDisabled = (element: HTMLElement) =>
  element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue(LISTED);
  applyMock.mockReset();
  applyMock.mockResolvedValue({ agents: {} });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

afterEach(() => {
  cleanup();
  dispatchMock.mockClear();
});

function pick(name: string) {
  act(() => {
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Account" }), { key: "ArrowDown" });
  });
  act(() => {
    fireEvent.keyDown(screen.getByRole("option", { name }), { key: "Enter" });
  });
}

const confirmButton = (name: string) => screen.getByRole("button", { name });

describe("UseAccountEverywhereDialog (#17893)", () => {
  it("lists every worktree pick and preset pin on another login, checked, and marks a missing worktree", async () => {
    renderDialog(FRESH);

    expect(listMock).toHaveBeenCalledWith("claude", "fresh");
    await screen.findByRole("checkbox", { name: "/work/app/main" });
    expect(screen.getByText("Use 'Fresh' everywhere?")).toBeTruthy();
    expect(checked("/work/app/main")).toBe("true");
    expect(checked("/work/site/old")).toBe("true");
    expect(checked("Review")).toBe("true");
    expect(
      screen.getByRole("checkbox", { name: "/work/app/main", description: "On Spent" })
    ).toBeTruthy();
    expect(
      screen.getByRole("checkbox", {
        name: "/work/site/old",
        description: "On Default login Worktree missing",
      })
    ).toBeTruthy();
    // Another preset has its id, so a clear by id can't say which is meant.
    expect(
      screen.getByRole("checkbox", {
        name: "Twin",
        description: "On Spent Another preset has its id, so it stays",
      })
    ).toBeTruthy();
    expect(checked("Twin")).toBe("false");
    expect(isDisabled(screen.getByRole("checkbox", { name: "Twin" }))).toBe(true);
    expect(
      screen.getAllByRole("group").map((group) => group.firstElementChild?.textContent)
    ).toEqual(["2 worktrees", "2 presets"]);
  });

  it("names a worktree by its whole path, spaces and all", async () => {
    listMock.mockResolvedValue({
      worktrees: [{ worktreeId: "/Users/me/Client Work/main", accountId: "spent", gone: false }],
      presets: [],
    });
    renderDialog(FRESH);

    expect(
      await screen.findByRole("checkbox", {
        name: "/Users/me/Client Work/main",
        description: "On Spent",
      })
    ).toBeTruthy();
  });

  it("sends exactly what's left checked, once, with the account each was listed under", async () => {
    const { onClose, onSaved } = renderDialog(FRESH);
    await screen.findByRole("checkbox", { name: "Review" });

    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "/work/app/main" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Review" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Review" }));
    });
    expect(checked("/work/app/main")).toBe("false");
    expect(checked("Review")).toBe("true");
    await act(async () => {
      fireEvent.click(confirmButton("Use Fresh everywhere"));
    });

    expect(applyMock.mock.calls).toEqual([
      [
        {
          agentId: "claude",
          accountId: "fresh",
          clear: {
            worktrees: [{ worktreeId: "/work/site/old", accountId: null }],
            presets: [{ presetId: "review", accountId: "spent" }],
          },
        },
      ],
    ]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    // No running terminal here is off the account, so there's nothing to offer.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("leaves an unchecked pin out, and can make the default login the one used everywhere", async () => {
    renderDialog(FRESH);
    await screen.findByRole("checkbox", { name: "Review" });
    pick("Default login");
    expect(listMock).toHaveBeenLastCalledWith("claude", null);
    await screen.findByText("Use 'Default login' everywhere?");
    await screen.findByRole("checkbox", { name: "Review" });

    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Review" }));
    });
    await act(async () => {
      fireEvent.click(confirmButton("Use Default login everywhere"));
    });

    expect(applyMock).toHaveBeenCalledWith({
      agentId: "claude",
      accountId: null,
      clear: {
        worktrees: [
          { worktreeId: "/work/app/main", accountId: "spent" },
          { worktreeId: "/work/site/old", accountId: null },
        ],
        presets: [],
      },
    });
  });

  it("lists again, open, when a checked choice was changed elsewhere while it was open", async () => {
    applyMock.mockResolvedValue({
      agents: { claude: { accountId: "fresh", worktreeAccounts: { "/work/app/main": "other" } } },
    });
    const { onClose, onSaved } = renderDialog(FRESH);
    await screen.findByRole("checkbox", { name: "Review" });
    listMock.mockResolvedValue({
      worktrees: [{ worktreeId: "/work/app/main", accountId: "other", gone: false }],
      presets: [],
    });

    await act(async () => {
      fireEvent.click(confirmButton("Use Fresh everywhere"));
    });

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("1 checked choice changed while this was open")).toBeTruthy();
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByRole("checkbox", {
        name: "/work/app/main",
        description: "On a removed account",
      })
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Review" })).toBeNull();
  });

  it("offers this project's running terminals afterwards, and restarts none by itself", async () => {
    seedPanes([
      { title: "Parser", agentAccountId: "spent" },
      { title: "Codex pane", launchAgentId: "codex", agentAccountId: "spent" },
      { title: "Already fresh", agentAccountId: "fresh" },
    ]);
    const saved = deferred<AgentSettings>();
    applyMock.mockReturnValue(saved.promise);
    const { onClose } = renderDialog(FRESH);
    await screen.findByRole("checkbox", { name: "Review" });

    act(() => {
      fireEvent.click(confirmButton("Use Fresh everywhere"));
    });
    // Nothing is offered until the change is saved.
    expect(screen.queryByText("Restart 1 terminal on 'Fresh'?")).toBeNull();
    await act(async () => {
      saved.resolve({ agents: {} });
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Restart 1 terminal on 'Fresh'?")).toBeTruthy();
    expect(checked("Parser")).toBe("true");
    expect(dispatchMock).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with the reason when the save fails, ready to try again", async () => {
    applyMock.mockRejectedValueOnce(new Error("That account isn't saved any more."));
    const { onClose, onSaved } = renderDialog(FRESH);
    await screen.findByRole("checkbox", { name: "Review" });

    await act(async () => {
      fireEvent.click(confirmButton("Use Fresh everywhere"));
    });

    expect(screen.getByText("Couldn't use the account everywhere")).toBeTruthy();
    expect(screen.getByText("That account isn't saved any more.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(isDisabled(confirmButton("Use Fresh everywhere"))).toBe(false);

    await act(async () => {
      fireEvent.click(confirmButton("Use Fresh everywhere"));
    });
    expect(applyMock).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never shows a list read for an account picked before the current one", async () => {
    const first = deferred<AccountChoicesAway>();
    listMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
      worktrees: [],
      presets: [{ presetId: "review", presetName: "Review", accountId: "fresh" }],
    });
    renderDialog(FRESH);

    pick("Spent");
    await screen.findByText("On Fresh");
    expect(listMock).toHaveBeenLastCalledWith("claude", "spent");

    await act(async () => {
      first.resolve(LISTED);
    });
    expect(screen.queryByRole("checkbox", { name: "/work/app/main" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Review", description: "On Fresh" })).toBeTruthy();
    expect(screen.getByText("Use 'Spent' everywhere?")).toBeTruthy();
  });

  it("reads again on going back to an account, and can't save until that answer lands", async () => {
    renderDialog(FRESH);
    await screen.findByRole("checkbox", { name: "Review" });
    pick("Spent");
    await screen.findByText("Use 'Spent' everywhere?");

    const again = deferred<AccountChoicesAway>();
    listMock.mockReturnValueOnce(again.promise);
    pick("Fresh");
    expect(listMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("checkbox", { name: "Review" })).toBeNull();
    expect(isDisabled(confirmButton("Use Fresh everywhere"))).toBe(true);

    await act(async () => {
      again.resolve({ worktrees: [], presets: [] });
    });
    expect(screen.getByText("No worktree or preset chooses another account")).toBeTruthy();
  });

  it("waits for the list before it can save, and offers a retry when it can't be read", async () => {
    listMock.mockRejectedValueOnce(new Error("Host unreachable"));
    renderDialog(FRESH);

    expect(isDisabled(confirmButton("Use Fresh everywhere"))).toBe(true);
    await screen.findByText("Couldn't read the saved choices");
    expect(screen.getByText("Host unreachable")).toBeTruthy();
    expect(isDisabled(confirmButton("Use Fresh everywhere"))).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await screen.findByRole("checkbox", { name: "Review" });
    expect(screen.queryByText("Couldn't read the saved choices")).toBeNull();
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(isDisabled(confirmButton("Use Fresh everywhere"))).toBe(false);
  });

  it("says when only the default changes, and has nothing to save when that's already it", async () => {
    listMock.mockResolvedValue({ worktrees: [], presets: [] });
    renderDialog(FRESH);
    await screen.findByText("No worktree or preset chooses another account");
    expect(isDisabled(confirmButton("Use Fresh everywhere"))).toBe(false);

    cleanup();
    renderDialog(SPENT);
    await screen.findByText(
      "Spent is already the default, and no worktree or preset chooses another account"
    );
    expect(isDisabled(confirmButton("Use Spent everywhere"))).toBe(true);
  });

  it("can clear choices for the account that's already the default", async () => {
    renderDialog(SPENT);
    await screen.findByRole("checkbox", { name: "Review" });
    expect(isDisabled(confirmButton("Use Spent everywhere"))).toBe(false);
  });

  it("asks for an account when none is given, and for another once the picked one is removed", async () => {
    renderDialog(undefined, { accountId: "removed" });
    expect(screen.getByText("Use which Claude account everywhere?")).toBeTruthy();
    expect(listMock).not.toHaveBeenCalled();
    expect(isDisabled(confirmButton("Use account everywhere"))).toBe(true);

    cleanup();
    renderDialog(FRESH);
    await screen.findByRole("checkbox", { name: "Review" });
    act(() => {
      useAgentSettingsStore.setState({
        settings: {
          agents: { claude: { accounts: [{ ...SPENT, configDir: "/Users/me/.claude-spent" }] } },
        } satisfies AgentSettings,
      });
    });
    await waitFor(() =>
      expect(screen.getByText("Use which Claude account everywhere?")).toBeTruthy()
    );
    expect(screen.queryByRole("checkbox", { name: "Review" })).toBeNull();
  });

  it("tells a saved account named like the default login apart from the default login", async () => {
    renderDialog(
      { id: "default-login", name: "Odd" },
      {
        accounts: [{ id: "default-login", name: "Odd", configDir: "/Users/me/.claude-odd" }],
      }
    );
    await screen.findByRole("checkbox", { name: "Review" });
    expect(listMock).toHaveBeenCalledWith("claude", "default-login");
    pick("Default login");
    expect(listMock).toHaveBeenLastCalledWith("claude", null);
  });
});

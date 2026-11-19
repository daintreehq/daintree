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
        description: "On Default login · Worktree missing",
      })
    ).toBeTruthy();
    // Another preset has its id, so a clear by id can't say which is meant.
    expect(checked("Twin")).toBe("false");
    expect(isDisabled(screen.getByRole("checkbox", { name: "Twin" }))).toBe(true);
    expect(
      screen.getAllByRole("group").map((group) => group.firstElementChild?.textContent)
    ).toEqual(["2 worktrees", "2 presets"]);
  });

  it("sends exactly what's left checked, with the account each was listed under", async () => {
    const { onClose, onSaved } = renderDialog(FRESH);
    await screen.findByRole("checkbox", { name: "Review" });

    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "/work/app/main" }));
    });
    expect(checked("/work/app/main")).toBe("false");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use Fresh everywhere" }));
    });

    expect(applyMock).toHaveBeenCalledWith({
      agentId: "claude",
      accountId: "fresh",
      clear: {
        worktrees: [{ worktreeId: "/work/site/old", accountId: null }],
        presets: [{ presetId: "review", accountId: "spent" }],
      },
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    // No running terminal here is off the account, so there's nothing to offer.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("offers this project's running terminals afterwards, and restarts none by itself", async () => {
    seedPanes([
      { title: "Parser", agentAccountId: "spent" },
      { title: "Already fresh", agentAccountId: "fresh" },
    ]);
    const { onClose } = renderDialog(FRESH);
    await screen.findByRole("checkbox", { name: "Review" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use Fresh everywhere" }));
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

  it("keeps the dialog open with the reason when the save fails", async () => {
    applyMock.mockRejectedValue(new Error("That account isn't saved any more."));
    const { onClose, onSaved } = renderDialog(FRESH);
    await screen.findByRole("checkbox", { name: "Review" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use Fresh everywhere" }));
    });

    expect(screen.getByText("Couldn't use the account everywhere")).toBeTruthy();
    expect(screen.getByText("That account isn't saved any more.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("never shows a list read for an account picked before the current one", async () => {
    const first = deferred<AccountChoicesAway>();
    listMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
      worktrees: [],
      presets: [{ presetId: "review", presetName: "Review", accountId: "fresh" }],
    });
    renderDialog(FRESH);

    act(() => {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Account" }), { key: "ArrowDown" });
    });
    act(() => {
      fireEvent.keyDown(screen.getByRole("option", { name: "Spent" }), { key: "Enter" });
    });
    await screen.findByText("On Fresh");
    expect(listMock).toHaveBeenLastCalledWith("claude", "spent");

    await act(async () => {
      first.resolve(LISTED);
    });
    expect(screen.queryByRole("checkbox", { name: "/work/app/main" })).toBeNull();
    expect(screen.getByText("Use 'Spent' everywhere?")).toBeTruthy();
  });

  it("waits for the list before it can save, and offers a retry when it can't be read", async () => {
    listMock.mockRejectedValueOnce(new Error("Host unreachable"));
    renderDialog(FRESH);

    expect(isDisabled(screen.getByRole("button", { name: "Use Fresh everywhere" }))).toBe(true);
    await screen.findByText("Couldn't read the saved choices");
    expect(screen.getByText("Host unreachable")).toBeTruthy();
    expect(isDisabled(screen.getByRole("button", { name: "Use Fresh everywhere" }))).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await screen.findByRole("checkbox", { name: "Review" });
    expect(screen.queryByText("Couldn't read the saved choices")).toBeNull();
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("says when only the default changes, and has nothing to save when that's already it", async () => {
    listMock.mockResolvedValue({ worktrees: [], presets: [] });
    renderDialog(FRESH);
    await screen.findByText(
      "No worktree or preset chooses another account, so only the default changes"
    );
    expect(isDisabled(screen.getByRole("button", { name: "Use Fresh everywhere" }))).toBe(false);

    cleanup();
    renderDialog(SPENT);
    await screen.findByText("Every Claude launch already signs in as Spent");
    expect(isDisabled(screen.getByRole("button", { name: "Use Spent everywhere" }))).toBe(true);
  });

  it("asks for an account when none is given, and for another once the picked one is removed", async () => {
    renderDialog(undefined, { accountId: "removed" });
    expect(screen.getByText("Use which Claude account everywhere?")).toBeTruthy();
    expect(listMock).not.toHaveBeenCalled();
    expect(isDisabled(screen.getByRole("button", { name: "Use account everywhere" }))).toBe(true);

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
});

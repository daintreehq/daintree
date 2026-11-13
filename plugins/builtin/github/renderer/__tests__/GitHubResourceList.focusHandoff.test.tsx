/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { whenPluginUiReady } from "@daintreehq/plugin-ui";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Issue, Page } from "@shared/types/forge";
import { _resetForTests } from "@/lib/forgeResourceCache";
import { FixedDropdownVisibleContext } from "@/components/ui/fixed-dropdown";
import { useGitHubFilterStore } from "../stores/githubFilterStore";

/**
 * The toolbar's forge dropdown hands the user off to a modal (a new worktree,
 * a bulk create). Whatever the panel does on its way out — a closing row or
 * header menu handing focus back to the search field — must not pull focus
 * out of the dialog that has just taken it.
 */

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@daintreehq/plugin-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@daintreehq/plugin-ui")>();
  return {
    ...actual,
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

const mockListIssues = vi.fn();

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    listIssues: (cwd: string, opts?: object) => mockListIssues({ cwd, ...opts }),
    listPRs: vi.fn(),
    getIssue: vi.fn(),
    getPR: vi.fn(),
    getIssueUrl: vi.fn().mockResolvedValue("https://github.com/acme/repo/issues/1"),
    getIssuesByNumbers: vi.fn().mockResolvedValue([]),
    getPRsByNumbers: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../stores/githubConfigStore", () => {
  const state = {
    isInitialized: true,
    config: { hasToken: true },
    initialize: () => Promise.resolve(),
  };
  const useGitHubConfigStore = (selector: (s: typeof state) => unknown) => selector(state);
  (useGitHubConfigStore as unknown as { getState: () => unknown }).getState = () => state;
  return { useGitHubConfigStore };
});

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

vi.mock("@/components/Worktree/LiveTimeAgo", () => ({
  LiveTimeAgo: () => <span>1m</span>,
}));

const { selection } = vi.hoisted(() => ({
  selection: { items: new Map<number, unknown>() },
}));

vi.mock("@/hooks/useIssueSelection", () => ({
  useIssueSelection: () => ({
    get selectedIds() {
      return new Set(selection.items.keys());
    },
    get isSelectionActive() {
      return selection.items.size > 0;
    },
    get selectedItems() {
      return selection.items;
    },
    toggle: vi.fn(),
    toggleRange: vi.fn(),
    selectAll: vi.fn(),
    reconcile: vi.fn(),
    clear: vi.fn(),
  }),
}));

/** A stand-in for the app's dialog host: one flag the store's openers raise. */
const { dialogStore } = vi.hoisted(() => {
  let open = false;
  const listeners = new Set<() => void>();
  return {
    dialogStore: {
      get: () => open,
      set: (next: boolean) => {
        open = next;
        listeners.forEach((l) => l());
      },
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
  };
});

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      openCreateDialog: () => dialogStore.set(true),
      openCreateDialogForPR: () => dialogStore.set(true),
      openBulkCreateDialog: () => dialogStore.set(true),
      openBulkCreateDialogForPRs: () => dialogStore.set(true),
      selectWorktree: vi.fn(),
      activeWorktreeId: null,
    }),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStoreOptional: (selector: (s: { worktrees: unknown }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
    computeItemKey,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => ReactNode;
    computeItemKey?: (index: number, item: unknown) => React.Key;
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={computeItemKey ? computeItemKey(index, item) : index}>
          {itemContent(index, item)}
        </div>
      ))}
    </div>
  ),
}));

import { GitHubResourceList } from "../components/GitHubResourceList";

const makeIssue = (n: number): Issue => ({
  number: n,
  title: `Issue #${n}`,
  body: "",
  url: `https://github.com/test/repo/issues/${n}`,
  state: "open",
  rawState: "OPEN",
  updatedAt: 0,
  createdAt: 0,
  author: { login: "user", avatarUrl: "", rawData: null },
  assignees: [],
  labels: [],
  commentCount: 0,
  rawData: null,
});

/**
 * Takes focus a task after it mounts, as `NewWorktreeDialog` does with its
 * branch field. Not during the opening commit: a row menu's focus trap is still
 * live then and bounces it, in the app as here.
 */
function StandInDialog({ takesFocus }: { takesFocus: boolean }) {
  const open = useSyncExternalStore(dialogStore.subscribe, dialogStore.get);
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open || !takesFocus) return;
    const timer = setTimeout(() => fieldRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open, takesFocus]);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="New worktree">
      <input ref={fieldRef} aria-label="Branch name" />
    </div>
  );
}

/**
 * The toolbar's side of the contract: `onClose` closes the panel and puts
 * focus back on the pill, synchronously, before the dialog has committed. The
 * panel itself stays painted, as it does through the real dropdown's exit.
 */
function ToolbarHarness({
  closesUnderModal = true,
  dialogTakesFocus = true,
}: {
  closesUnderModal?: boolean;
  /** Off for a dialog that has already placed its focus and won't move it again. */
  dialogTakesFocus?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const pillRef = useRef<HTMLButtonElement>(null);
  // A modal rising over the toolbar closes the dropdown, unless the pill keeps
  // it open through child overlays as the Issues pill does.
  const dialogOpen = useSyncExternalStore(dialogStore.subscribe, dialogStore.get);
  return (
    <>
      <button ref={pillRef} type="button">
        Issues pill
      </button>
      <FixedDropdownVisibleContext.Provider value={open && !(closesUnderModal && dialogOpen)}>
        <GitHubResourceList
          type="issue"
          projectPath="/test/proj"
          onClose={() => {
            setOpen(false);
            pillRef.current?.focus();
          }}
        />
      </FixedDropdownVisibleContext.Provider>
      <StandInDialog takesFocus={dialogTakesFocus} />
    </>
  );
}

const page = (items: Issue[]): Page<Issue> => ({ items, nextCursor: null, hasMore: false });

/** Radix hands focus back from a closed menu on a zero-delay timer; let every one run. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });

beforeAll(() => whenPluginUiReady(), 30_000);

beforeEach(() => {
  _resetForTests();
  dialogStore.set(false);
  selection.items = new Map();
  mockListIssues.mockReset().mockResolvedValue(page([makeIssue(1), makeIssue(2)]));
  const filters = useGitHubFilterStore.getState();
  filters.setIssueSearchQuery("");
  filters.setIssueFilter("open");
});

afterEach(() => {
  cleanup();
});

describe("GitHubResourceList hand-off to a dialog", () => {
  it("keeps focus in the new worktree dialog opened from a row's actions menu", async () => {
    render(<ToolbarHarness />);
    const trigger = await screen.findByLabelText("Actions for #1");

    act(() => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    });
    const item = await screen.findByRole("menuitem", { name: /create worktree/i });

    act(() => {
      fireEvent.click(item);
    });
    await settle();

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Branch name"));
  });

  it("keeps focus in a dialog that opens while a header menu is closing with the panel", async () => {
    render(<ToolbarHarness />);
    const trigger = await screen.findByRole("button", { name: "View options" });
    act(() => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    });
    await screen.findByRole("menu");

    // Something outside the panel opens a modal (a shortcut, say); the
    // dropdown closes under it and takes its menus down with it.
    act(() => {
      dialogStore.set(true);
    });
    await settle();

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(screen.getByLabelText("Branch name"));
  });

  it("keeps focus in the bulk create dialog opened from the selection bar", async () => {
    const one = makeIssue(1);
    selection.items = new Map([[1, one]]);
    render(<ToolbarHarness />);

    const create = await screen.findByTestId("bulk-action-create-worktrees-button");
    act(() => {
      fireEvent.click(create);
    });
    await settle();

    expect(document.activeElement).toBe(screen.getByLabelText("Branch name"));
  });

  it("leaves focus in a modal that took it while the panel stays open under it", async () => {
    render(<ToolbarHarness closesUnderModal={false} dialogTakesFocus={false} />);
    const trigger = await screen.findByLabelText("Actions for #2");
    act(() => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    });
    const menu = await screen.findByRole("menu");

    // The menu is gone, its hand-back still queued, when a modal takes focus.
    act(() => {
      fireEvent.keyDown(menu, { key: "Escape" });
    });
    act(() => {
      dialogStore.set(true);
    });
    const field = screen.getByLabelText("Branch name");
    act(() => {
      field.focus();
    });
    expect(document.activeElement).toBe(field);
    await settle();

    expect(document.activeElement).toBe(field);
  });

  it("still hands focus back to the search field when a row menu closes with the panel open", async () => {
    render(<ToolbarHarness />);
    const trigger = await screen.findByLabelText("Actions for #2");
    act(() => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    });
    const menu = await screen.findByRole("menu");

    act(() => {
      fireEvent.keyDown(menu, { key: "Escape" });
    });
    await settle();

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/search issues/i));
  });
});

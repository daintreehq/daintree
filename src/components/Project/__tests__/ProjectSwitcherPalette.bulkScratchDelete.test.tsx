/**
 * @vitest-environment jsdom
 *
 * Scratch deletion from the switcher palette: bulk "delete all" from the section
 * header's ⋯ menu, its context menu and the end of every row's context menu
 * (#11086, #11705), plus single delete from a row's context menu (#11522). All
 * share this harness because they share the surface — the section header and the
 * rows under it — and splitting them would fork 150 lines of identical mocks.
 *
 * Uses the REAL menu primitives — the whole point of the feature is that a
 * right-click on the header opens a menu instead of collapsing the section,
 * and an inline stub that renders items as plain buttons would pass even if the
 * trigger were never wired. `ConfirmDialog` is stubbed to a prop-rendering seam: its
 * own gates (typed-name, cooldown, aria) have their own suite, so what matters here
 * is which props the palette hands it.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";

const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
});
afterAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: originalScrollIntoView,
    configurable: true,
  });
});

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/lib/colorUtils", () => ({
  getProjectGradient: () => "linear-gradient(red, blue)",
}));

vi.mock("@/hooks/useKeybinding", () => ({
  useKeybindingDisplay: () => "⌘P",
  useEffectiveCombo: () => undefined,
}));

vi.mock("@/hooks", () => ({
  useOverlayState: () => {},
  useOverlayClaim: () => {},
}));
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
  useOverlayState: () => {},
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

vi.mock("@/store/uiStore", () => ({
  useUIStore: () => 0,
}));

vi.mock("@/components/ui/AppPaletteDialog", () => {
  const Header = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const Input = ({
    inputRef,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    inputRef?: React.Ref<HTMLInputElement>;
  }) => <input ref={inputRef} data-testid="palette-input" {...props} />;
  const Body = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const Footer = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;

  const Dialog = ({
    isOpen,
    children,
    ariaLabel,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    ariaLabel: string;
  }) =>
    isOpen ? (
      <div role="dialog" aria-modal="true" aria-label={ariaLabel}>
        {children}
      </div>
    ) : null;
  Dialog.Header = Header;
  Dialog.Input = Input;
  Dialog.Body = Body;
  Dialog.Footer = Footer;
  Dialog.Divider = (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />;
  Dialog.Empty = ({
    query,
    emptyMessage,
    noMatchMessage,
    noMatchContent,
  }: {
    query: string;
    emptyMessage?: string;
    noMatchMessage?: string;
    noMatchContent?: React.ReactNode;
  }) =>
    query.trim() ? (
      <div>
        <p>{noMatchMessage}</p>
        {noMatchContent}
      </div>
    ) : (
      <p>{emptyMessage}</p>
    );

  return {
    AppPaletteDialog: Dialog,
    PaletteNoMatchHint: () => <p>Press Esc to clear the search</p>,
    KBD_CLASS: "kbd",
    PALETTE_SURFACE_WIDTHS: {
      // Sentinel values, not the production pixels: this mock only has to satisfy
      // the real AppPalettePopover's width lookup, and copying the shipped
      // classes here would couple every future resize to six mock factories.
      anchored: "mock-anchored-width",
      command: "mock-command-width",
    },
  };
});

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// Prop-rendering seam. Everything the palette decides — the counted title, the
// verb-noun confirm label, whether dismissal is allowed mid-run — is visible here.
vi.mock("@/components/ui/ConfirmDialog", async () => {
  const { useEffect, useState } = await vi.importActual<typeof import("react")>("react");
  return {
    ConfirmDialog: ({
      isOpen,
      title,
      children,
      confirmLabel,
      cancelLabel,
      onConfirm,
      onClose,
      isConfirmLoading,
      isBusy,
      variant,
      typedNameTarget,
      restoreFocusTo,
      confirmDisabled,
    }: {
      isOpen: boolean;
      title: React.ReactNode;
      children?: React.ReactNode;
      confirmLabel: string;
      cancelLabel?: string;
      onConfirm: () => void;
      onClose?: () => void;
      isConfirmLoading?: boolean;
      isBusy?: boolean;
      variant: string;
      typedNameTarget?: string;
      confirmDisabled?: boolean;
      restoreFocusTo?: React.RefObject<HTMLElement | null> | (() => HTMLElement | null);
    }) => {
      // Resolved after mount, not during render: a ref handed down from the
      // palette is still null while the dialog is rendering.
      const [restoreTarget, setRestoreTarget] = useState("");
      useEffect(() => {
        if (!restoreFocusTo) return;
        const el = typeof restoreFocusTo === "function" ? restoreFocusTo() : restoreFocusTo.current;
        setRestoreTarget(el?.getAttribute("data-testid") ?? "");
      }, [restoreFocusTo]);

      return isOpen ? (
        <div
          data-testid="confirm-dialog"
          data-variant={variant}
          data-loading={String(Boolean(isConfirmLoading))}
          // The real dialog locks dismissal while loading or busy; the X stays.
          data-dismissable={String(Boolean(onClose) && !isConfirmLoading && !isBusy)}
          data-typed-name-target={typedNameTarget ?? ""}
          data-confirm-disabled={String(Boolean(confirmDisabled || isBusy))}
          data-restore-focus={restoreTarget}
        >
          <h2 data-testid="confirm-title">{title}</h2>
          <div data-testid="confirm-body">{children}</div>
          {/* Addressed by role, not by label: pinning the locator to the exact copy
              would make every interaction spec fail on a wording change. */}
          <button type="button" data-testid="confirm-accept" onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button type="button" data-testid="confirm-cancel" onClick={onClose}>
            {cancelLabel}
          </button>
        </div>
      ) : null;
    },
  };
});

vi.mock("@/hooks/useModifierKeys", () => ({
  useModifierKeys: () => ({ meta: false, alt: false }),
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: () => "1h ago",
}));

import type {
  DeleteAllScratchesSnapshot,
  SearchableScratch,
} from "@/hooks/useProjectSwitcherPalette";
import { primeRadix } from "@/components/ui/radix-loader";

const { ProjectSwitcherPalette } = await import("../ProjectSwitcherPalette");
const { usePreferencesStore } = await import("@/store/preferencesStore");

beforeAll(async () => {
  // The context-menu primitives resolve through the lazy Radix loader; without
  // priming, the trigger renders as an inert passthrough and never opens.
  await primeRadix();
});

function makeScratch(index: number): SearchableScratch {
  return {
    id: `scratch-${index}`,
    name: `Spike ${index}`,
    path: `/tmp/scratches/scratch-${index}`,
    createdAt: 1_000 + index,
    lastOpened: 1_000 + index,
    isActive: false,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    processCount: 0,
  };
}

function baseProps() {
  return {
    isOpen: true,
    mode: "modal" as const,
    query: "",
    results: [],
    selectedIndex: 0,
    onQueryChange: vi.fn(),
    onSelectPrevious: vi.fn(),
    onSelectNext: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    scratchResults: [] as SearchableScratch[],
    onCreateScratch: vi.fn(),
    onRenameScratch: vi.fn(),
    onSelectScratch: vi.fn(),
    onRequestDeleteScratch: vi.fn(),
    onDismissDeleteScratchConfirm: vi.fn(),
    onConfirmDeleteScratch: vi.fn(),
    onRequestDeleteAllScratches: vi.fn(),
    onDismissDeleteAllScratchesConfirm: vi.fn(),
    onConfirmDeleteAllScratches: vi.fn(),
  };
}

function renderPalette(overrides: Record<string, unknown> = {}) {
  const props = { ...baseProps(), ...overrides };
  const view = render(<ProjectSwitcherPalette {...props} />);
  return { props, view };
}

/**
 * The Scratch band's header, the context-menu trigger. It leads the band's one
 * listbox in both lives: a pointer-only bar while open, an option while folded.
 * Found in the DOM rather than by role: open, the bar is hidden from the a11y
 * tree on purpose.
 */
function scratchHeader(): HTMLElement {
  const header = document.getElementById("scratch-list")?.firstElementChild;
  if (!(header instanceof HTMLElement)) throw new Error("Scratch section header not found");
  return header;
}

/** What a click folds or unfolds with: the bar's toggle open, the whole header folded. */
function scratchFoldTarget(): HTMLElement {
  return (
    document.getElementById("band-option-scratch") ?? screen.getByTestId("scratch-band-toggle")
  );
}

function isScratchFolded(): boolean {
  return document.getElementById("band-option-scratch") !== null;
}

/** Radix opens a dropdown on primary-button pointerdown, not on click. */
function openHeaderMenu(): void {
  fireEvent.pointerDown(screen.getByTestId("scratch-band-menu"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

/**
 * The header menu's only item. Queried by role rather than by its label so the
 * specs assert behavior instead of re-stating the copy they'd break on.
 */
function deleteAllItem(): HTMLElement | null {
  return screen.queryByRole("menuitem");
}

function snapshotOf(count: number): DeleteAllScratchesSnapshot {
  return Array.from({ length: count }, (_, i) => ({ id: `scratch-${i}`, name: `Spike ${i}` }));
}

/** The count the dialog is actually showing, pulled back out of its title. */
function confirmedCount(): number {
  const title = screen.getByTestId("confirm-title").textContent ?? "";
  const match = /(\d+)/.exec(title);
  if (!match) throw new Error(`No count in confirm title: ${title}`);
  return Number(match[1]);
}

/** The noun the dialog uses for that count — the thing plural agreement is about. */
function confirmedNoun(): string {
  const title = screen.getByTestId("confirm-title").textContent ?? "";
  return /workspaces/i.test(title) ? "plural" : "singular";
}

/**
 * The number the consequence sentence is written in, read off its own noun so
 * the spec pins agreement with the title rather than the wording of either.
 */
function consequenceNoun(): string {
  const body = screen.getByTestId("confirm-body").textContent ?? "";
  return /folders/i.test(body) ? "plural" : "singular";
}

beforeEach(() => {
  vi.clearAllMocks();
  // Persisted and app-global (#11943): the collapse test below would otherwise
  // leave every later case looking at a folded section.
  usePreferencesStore.setState({ projectSwitcherCollapsedBands: {} });
});

// The action has to survive BOTH surfaces. The two hosts forward props through
// separate branches (DropdownContent vs ModalContent), so a modal-only suite stays
// green while the dropdown — the one most users actually reach — loses the action.
describe.each(["modal", "dropdown"] as const)("Scratch section header menu (%s)", (mode) => {
  it("offers the bulk delete once scratches exist, and not before", () => {
    const { view } = renderPalette({ mode, scratchResults: [] });

    fireEvent.contextMenu(scratchHeader());
    // Paired with the positive case below so this can't pass by the action simply
    // never existing — "absent when empty" is only meaningful next to "present when not".
    expect(deleteAllItem()).toBeNull();

    view.rerender(
      <ProjectSwitcherPalette
        {...baseProps()}
        mode={mode}
        scratchResults={[makeScratch(1), makeScratch(2)]}
      />
    );
    fireEvent.contextMenu(scratchHeader());

    expect(deleteAllItem()).not.toBeNull();
  });

  it("asks the host to open the confirmation when the item is chosen", () => {
    const { props } = renderPalette({ mode, scratchResults: [makeScratch(1), makeScratch(2)] });

    fireEvent.contextMenu(scratchHeader());
    const item = deleteAllItem();
    expect(item).not.toBeNull();
    fireEvent.click(item!);

    // The palette never deletes anything itself — it requests the confirm.
    expect(props.onRequestDeleteAllScratches).toHaveBeenCalledTimes(1);
    expect(props.onRequestDeleteScratch).not.toHaveBeenCalled();
  });

  it("hides the bulk delete when the host wires no handler, but shows it when wired", () => {
    const { view } = renderPalette({
      mode,
      scratchResults: [makeScratch(1)],
      onRequestDeleteAllScratches: undefined,
    });

    fireEvent.contextMenu(scratchHeader());
    expect(deleteAllItem()).toBeNull();

    view.rerender(
      <ProjectSwitcherPalette
        {...baseProps()}
        mode={mode}
        scratchResults={[makeScratch(1)]}
        onRequestDeleteAllScratches={vi.fn()}
      />
    );
    fireEvent.contextMenu(scratchHeader());

    expect(deleteAllItem()).not.toBeNull();
  });
});

/**
 * The header's ⋯ (#11705). Nothing advertised that the header was
 * right-clickable, so the practical experience was deleting scratches one row
 * at a time. It replaces the standing red row that used to sit one slip below
 * "New scratch workspace…".
 */
describe.each(["modal", "dropdown"] as const)("Scratch header actions menu (%s)", (mode) => {
  it("offers the bulk delete from the header once scratches exist", () => {
    const { props, view } = renderPalette({ mode, scratchResults: [makeScratch(1)] });

    // The standing row is gone; the header carries the action instead.
    expect(screen.queryByTestId("scratch-delete-all-button")).toBeNull();
    openHeaderMenu();
    const item = screen.getByRole("menuitem", { name: /Delete all scratch workspaces…/ });
    fireEvent.click(item);
    expect(props.onRequestDeleteAllScratches).toHaveBeenCalledTimes(1);

    // Paired with the positive case so this can't pass by the menu simply
    // never existing — "absent when empty" only means something next to it.
    view.rerender(<ProjectSwitcherPalette {...baseProps()} mode={mode} scratchResults={[]} />);

    expect(screen.queryByTestId("scratch-band-menu")).toBeNull();
  });

  it("stays available while the create-name editor is open", () => {
    // Opening the menu moves focus off the editor input. The menu must survive
    // that re-render and still take the click — and the abandoned name must
    // not be created on the way past.
    const { props } = renderPalette({ mode, scratchResults: [makeScratch(1)] });
    fireEvent.click(screen.getByTestId("scratch-create-button"));
    expect(screen.getByTestId("scratch-create-input")).toBeTruthy();

    const menu = screen.getByTestId("scratch-band-menu");
    // A real focus move, not fireEvent.blur: the ordering of blur against the
    // click is the whole risk here.
    menu.focus();
    expect(menu.isConnected).toBe(true);
    openHeaderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete all scratch workspaces…/ }));

    expect(props.onRequestDeleteAllScratches).toHaveBeenCalledTimes(1);
    expect(props.onCreateScratch).not.toHaveBeenCalled();
  });

  it("leaves the reach of the section it belongs to", () => {
    const { view } = renderPalette({ mode, scratchResults: [makeScratch(1)] });
    expect(screen.queryByTestId("scratch-band-menu")).not.toBeNull();

    // Folded, the header is an option and carries no ⋯.
    fireEvent.click(scratchFoldTarget());
    expect(isScratchFolded()).toBe(true);
    expect(screen.queryByTestId("scratch-band-menu")).toBeNull();
    fireEvent.click(scratchFoldTarget());
    expect(screen.queryByTestId("scratch-band-menu")).not.toBeNull();

    // Searching only sets `hidden` — the subtree stays mounted so a deliberate
    // collapse survives clearing the box — so the menu has to sit under it.
    view.rerender(
      <ProjectSwitcherPalette
        {...baseProps()}
        mode={mode}
        query="spike"
        scratchResults={[makeScratch(1)]}
      />
    );

    expect(screen.getByTestId("scratch-band-menu").closest("[hidden]")).not.toBeNull();
  });

  it("hides the menu when the host wires no handler, but shows it when wired", () => {
    const { view } = renderPalette({
      mode,
      scratchResults: [makeScratch(1)],
      onRequestDeleteAllScratches: undefined,
    });

    expect(screen.queryByTestId("scratch-band-menu")).toBeNull();

    view.rerender(
      <ProjectSwitcherPalette
        {...baseProps()}
        mode={mode}
        scratchResults={[makeScratch(1)]}
        onRequestDeleteAllScratches={vi.fn()}
      />
    );

    expect(screen.queryByTestId("scratch-band-menu")).not.toBeNull();
  });
});

describe("Scratch section header collapse toggle", () => {
  it("opens the menu without collapsing the section", () => {
    renderPalette({ scratchResults: [makeScratch(1)] });

    fireEvent.contextMenu(scratchHeader());

    // The header is also the fold target. If the right-click also reached its
    // onClick, the section would snap shut under the menu it just opened.
    expect(isScratchFolded()).toBe(false);
    expect(deleteAllItem()).not.toBeNull();
  });

  it("still collapses on an ordinary click, with the menu left intact", () => {
    renderPalette({ scratchResults: [makeScratch(1)] });

    fireEvent.click(scratchFoldTarget());
    expect(isScratchFolded()).toBe(true);

    // Non-regression, but only if the menu it shares the header with survives:
    // asserting the collapse alone would still pass with the whole feature reverted.
    fireEvent.contextMenu(scratchHeader());
    expect(deleteAllItem()).not.toBeNull();
  });
});

describe("Bulk delete confirmation", () => {
  it("agrees in number with the count it is showing", () => {
    const { view } = renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshotOf(1),
    });

    expect(confirmedCount()).toBe(1);
    expect(confirmedNoun()).toBe("singular");
    // The consequence sentence branches on the same count, so it has to move
    // with the title — "Delete 1 scratch workspace?" over "their folders" would
    // be describing a different operation than the one being agreed to.
    expect(consequenceNoun()).toBe("singular");

    view.rerender(
      <ProjectSwitcherPalette
        {...baseProps()}
        scratchResults={[makeScratch(1)]}
        deleteAllScratchesConfirm={snapshotOf(4)}
      />
    );

    expect(confirmedCount()).toBe(4);
    expect(confirmedNoun()).toBe("plural");
    expect(consequenceNoun()).toBe("plural");
  });

  it("opens only once a confirm is pending, and closes when it clears", () => {
    const { view } = renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshotOf(2),
    });
    expect(screen.queryByTestId("confirm-dialog")).not.toBeNull();

    // Rerendered to null rather than asserted on a fresh render: a spec that only
    // checks the empty case passes with the dialog deleted outright.
    view.rerender(
      <ProjectSwitcherPalette
        {...baseProps()}
        scratchResults={[makeScratch(1)]}
        deleteAllScratchesConfirm={null}
      />
    );

    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  });

  it("gates the delete behind a destructive dialog with no typed-name step", () => {
    renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshotOf(2),
    });

    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog.getAttribute("data-variant")).toBe("destructive");
    // D1, not D2: scratches are local throwaway workspaces, so the count carries the
    // consent — a typed-name gate here would be friction without a payoff.
    expect(dialog.getAttribute("data-typed-name-target")).toBe("");
  });

  it("runs the deletion when confirmed", () => {
    const { props } = renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshotOf(2),
    });

    fireEvent.click(screen.getByTestId("confirm-accept"));

    expect(props.onConfirmDeleteAllScratches).toHaveBeenCalledTimes(1);
    expect(props.onDismissDeleteAllScratchesConfirm).not.toHaveBeenCalled();
  });

  it("dismisses without deleting when cancelled", () => {
    const { props } = renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshotOf(2),
    });

    fireEvent.click(screen.getByTestId("confirm-cancel"));

    expect(props.onDismissDeleteAllScratchesConfirm).toHaveBeenCalledTimes(1);
    expect(props.onConfirmDeleteAllScratches).not.toHaveBeenCalled();
  });

  it("previews every target rather than a truncated head, and says so to a reader", () => {
    // Two share a name: keyed by id, they have to stay separate rows, since
    // "Spike" listed once would understate what is about to be deleted.
    const snapshot = Array.from({ length: 12 }, (_, i) => ({
      id: `frozen-${i}`,
      name: i < 2 ? "Spike" : `Spike ${i}`,
    })) satisfies DeleteAllScratchesSnapshot;

    renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshot,
    });

    const named = within(screen.getByTestId("scratch-delete-all-preview"))
      .getAllByRole("listitem")
      .map((item) => item.textContent);

    // A "+N more" tail would hand the hidden targets back the count-only
    // treatment the preview exists to replace. Only the viewport is capped.
    expect(named).toEqual(snapshot.map((target) => target.name));
  });

  it("hands focus back inside the palette, not to the trigger it just unmounted", () => {
    renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshotOf(2),
    });

    // Both triggers are gone once the run lands — the header menu's item and the
    // visible button are each gated on there being scratches left. Without a
    // named successor the restore walks to app chrome behind a still-`aria-modal`
    // palette, so the resolved target has to be the palette's own search box.
    expect(screen.getByTestId("confirm-dialog").getAttribute("data-restore-focus")).toBe(
      "palette-input"
    );
  });

  it("refuses dismissal while the deletion is in flight", () => {
    renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshotOf(2),
      isDeletingAllScratches: true,
    });

    const dialog = screen.getByTestId("confirm-dialog");
    // Escaping mid-run would strand the user with no view of the outcome while
    // folders keep disappearing underneath.
    expect(dialog.getAttribute("data-dismissable")).toBe("false");
    expect(dialog.getAttribute("data-loading")).toBe("true");
  });
});

/**
 * Single-scratch delete from the row's own context menu (#11522).
 *
 * Previously fired straight into the store with no confirm and no busy state.
 * Shares the bulk suite's prop-rendering seam, so what these specs pin is what
 * the palette decides: that the menu only ever *requests*, and that the dialog
 * it opens narrates the run rather than sitting mute on a spinner.
 */
describe("Single scratch delete", () => {
  /**
   * The row menu's single delete item. Not the last item any more: the bulk
   * delete closes every row's menu, as the keyboard's way to it.
   */
  function deleteItem(): HTMLElement {
    return screen.getByRole("menuitem", { name: /^Delete scratch/ });
  }

  function target(overrides: Record<string, unknown> = {}) {
    return {
      id: "scratch-1",
      name: "Spike 1",
      path: "/tmp/scratches/scratch-1",
      ...overrides,
    };
  }

  /** The run's live region, addressed by its role rather than a test id. */
  function progressText(): string {
    return screen.getByRole("status").textContent ?? "";
  }

  /**
   * A scratch row's context-menu trigger, found in the DOM rather than through
   * the a11y tree. An open Radix menu marks the rest of the page aria-hidden, so
   * a paired spec that reopens the menu can no longer reach the row by role.
   */
  function scratchRow(): HTMLElement {
    const row = document.querySelector<HTMLElement>('[role="option"]');
    if (!row) throw new Error("Scratch row not found");
    return row;
  }

  // Both hosts forward scratch props through separate branches, so a modal-only
  // suite stays green while the dropdown loses the action.
  describe.each(["modal", "dropdown"] as const)("row menu (%s)", (mode) => {
    it("requests the confirmation instead of deleting from the menu", () => {
      const { props } = renderPalette({ mode, scratchResults: [makeScratch(1)] });

      fireEvent.contextMenu(screen.getByRole("option", { name: /Spike 1/ }));
      fireEvent.click(deleteItem());

      expect(props.onRequestDeleteScratch).toHaveBeenCalledWith("scratch-1");
      expect(props.onRequestDeleteAllScratches).not.toHaveBeenCalled();
    });

    it("ends the row menu with the bulk delete, the keyboard's way to it", () => {
      const { props } = renderPalette({ mode, scratchResults: [makeScratch(1), makeScratch(2)] });

      fireEvent.contextMenu(screen.getByRole("option", { name: /Spike 1/ }));
      const last = screen.getAllByRole("menuitem").at(-1)!;
      expect(last.textContent).toContain("Delete all scratch workspaces…");
      fireEvent.click(last);

      expect(props.onRequestDeleteAllScratches).toHaveBeenCalledTimes(1);
      expect(props.onRequestDeleteScratch).not.toHaveBeenCalled();
    });

    it("hides the delete when the host wires no handler, but shows it when wired", () => {
      const { view } = renderPalette({
        mode,
        scratchResults: [makeScratch(1)],
        onRequestDeleteScratch: undefined,
      });

      fireEvent.contextMenu(scratchRow());
      // Paired with the positive case: "absent when unwired" is only meaningful
      // next to "present when wired".
      expect(screen.queryByText(/Delete scratch/)).toBeNull();

      view.rerender(
        <ProjectSwitcherPalette
          {...baseProps()}
          mode={mode}
          scratchResults={[makeScratch(1)]}
          onRequestDeleteScratch={vi.fn()}
        />
      );
      fireEvent.contextMenu(scratchRow());

      expect(screen.queryByText(/Delete scratch/)).not.toBeNull();
    });
  });

  it("opens only once a target is pending, and closes when it clears", () => {
    const { view } = renderPalette({
      scratchResults: [makeScratch(1)],
      deleteScratchConfirm: target(),
    });
    expect(screen.queryByTestId("confirm-dialog")).not.toBeNull();

    view.rerender(
      <ProjectSwitcherPalette
        {...baseProps()}
        scratchResults={[makeScratch(1)]}
        deleteScratchConfirm={null}
      />
    );

    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  });

  it("names the frozen target rather than the live row", () => {
    renderPalette({
      // The row has already drained away as the removal lands; the dialog must
      // keep naming what the user agreed to.
      scratchResults: [],
      deleteScratchConfirm: target({ name: "Retry queue spike" }),
    });

    expect(screen.getByTestId("confirm-title").textContent).toContain("Retry queue spike");
    expect(screen.getByTestId("confirm-body").textContent).toContain("/tmp/scratches/scratch-1");
  });

  it("gates the delete behind a destructive dialog with no typed-name step", () => {
    renderPalette({
      scratchResults: [makeScratch(1)],
      deleteScratchConfirm: target(),
    });

    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog.getAttribute("data-variant")).toBe("destructive");
    // D1: a scratch is a local throwaway workspace, so naming it carries the
    // consent — a typed-name gate would be friction without a payoff.
    expect(dialog.getAttribute("data-typed-name-target")).toBe("");
  });

  it("routes confirm and cancel to their own handlers", () => {
    const { props } = renderPalette({
      scratchResults: [makeScratch(1)],
      deleteScratchConfirm: target(),
    });

    fireEvent.click(screen.getByTestId("confirm-accept"));
    expect(props.onConfirmDeleteScratch).toHaveBeenCalledTimes(1);
    expect(props.onDismissDeleteScratchConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(props.onDismissDeleteScratchConfirm).toHaveBeenCalledTimes(1);
    expect(props.onConfirmDeleteScratch).toHaveBeenCalledTimes(1);
  });

  it("refuses dismissal from the first frame of the deletion", () => {
    renderPalette({
      scratchResults: [makeScratch(1)],
      deleteScratchConfirm: target(),
      isDeletingScratch: true,
    });

    // Escaping mid-run would strand the user with no view of the outcome while
    // the folder disappears underneath. Keyed on raw state, so there is no
    // window where the run has started but the dialog is still dismissable.
    expect(screen.getByTestId("confirm-dialog").getAttribute("data-dismissable")).toBe("false");
  });

  it("locks the button immediately but holds its spinner for the gate", () => {
    vi.useFakeTimers();
    try {
      renderPalette({
        scratchResults: [makeScratch(1)],
        deleteScratchConfirm: target(),
        isDeletingScratch: true,
      });

      // Disabled from the first frame — gating the lock too would leave a window
      // where a second press still went through — but no spinner yet, so a
      // scratch that deletes in 80ms never flashes one.
      const dialog = screen.getByTestId("confirm-dialog");
      expect(dialog.getAttribute("data-confirm-disabled")).toBe("true");
      expect(dialog.getAttribute("data-loading")).toBe("false");

      act(() => {
        vi.advanceTimersToNextTimer();
      });

      expect(dialog.getAttribute("data-loading")).toBe("true");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("carries no progress region until the deletion starts", () => {
    renderPalette({
      scratchResults: [makeScratch(1)],
      deleteScratchConfirm: target(),
    });

    // Reading the dialog is not the operation: a region present here would be
    // narrating a run that has not begun.
    expect(screen.queryByTestId("delete-scratch-progress")).toBeNull();
  });

  it("narrates the run once the gate clears, then escalates on a long wait", () => {
    vi.useFakeTimers();
    try {
      renderPalette({
        scratchResults: [makeScratch(1)],
        deleteScratchConfirm: target(),
        isDeletingScratch: true,
      });

      // Without this the whole feature could be deleted — an always-empty region
      // satisfies the gate spec above on its own.
      const beforeGate = progressText();
      act(() => {
        vi.advanceTimersToNextTimer();
      });
      const afterGate = progressText();
      act(() => {
        vi.advanceTimersToNextTimer();
      });
      const afterLongWait = progressText();

      expect(beforeGate).toBe("");
      expect(afterGate).not.toBe("");
      // The escalation adds to the narration rather than replacing it, so the
      // user never loses sight of what is running.
      expect(afterLongWait.startsWith(afterGate)).toBe(true);
      expect(afterLongWait.length).toBeGreaterThan(afterGate.length);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("hands focus back inside the palette, not to the row it just deleted", () => {
    renderPalette({
      scratchResults: [makeScratch(1)],
      deleteScratchConfirm: target(),
    });

    // The trigger row is gone once the delete lands, so without a named successor
    // the dialog's restore walks to app chrome behind a still-`aria-modal`
    // palette. The resolved target has to be the palette's own search box.
    const restored = screen.getByTestId("confirm-dialog").getAttribute("data-restore-focus");
    expect(restored).toBe("palette-input");
  });
});

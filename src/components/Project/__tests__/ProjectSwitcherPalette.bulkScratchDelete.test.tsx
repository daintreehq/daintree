/**
 * @vitest-environment jsdom
 *
 * Bulk "delete all scratch workspaces" from the Scratch section header (#11086).
 *
 * Uses the REAL context-menu primitives — the whole point of the feature is that a
 * right-click on the collapse toggle opens a menu instead of collapsing the section,
 * and an inline stub that renders items as plain buttons would pass even if the
 * trigger were never wired. `ConfirmDialog` is stubbed to a prop-rendering seam: its
 * own gates (typed-name, cooldown, aria) have their own suite, so what matters here
 * is which props the palette hands it.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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

  return { AppPaletteDialog: Dialog, KBD_CLASS: "kbd" };
});

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Prop-rendering seam. Everything the palette decides — the counted title, the
// verb-noun confirm label, whether dismissal is allowed mid-run — is visible here.
vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    children,
    confirmLabel,
    cancelLabel,
    onConfirm,
    onClose,
    isConfirmLoading,
    variant,
    typedNameTarget,
  }: {
    isOpen: boolean;
    title: React.ReactNode;
    children?: React.ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onClose?: () => void;
    isConfirmLoading?: boolean;
    variant: string;
    typedNameTarget?: string;
  }) =>
    isOpen ? (
      <div
        data-testid="confirm-dialog"
        data-variant={variant}
        data-loading={String(Boolean(isConfirmLoading))}
        data-dismissable={String(Boolean(onClose))}
        data-typed-name-target={typedNameTarget ?? ""}
      >
        <h2 data-testid="confirm-title">{title}</h2>
        <div data-testid="confirm-body">{children}</div>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" onClick={onClose}>
          {cancelLabel}
        </button>
      </div>
    ) : null,
}));

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
    onRemoveScratch: vi.fn(),
    onRequestDeleteAllScratches: vi.fn(),
    onDismissDeleteAllScratchesConfirm: vi.fn(),
    onConfirmDeleteAllScratches: vi.fn(),
  };
}

function renderPalette(overrides: Record<string, unknown> = {}) {
  const props = { ...baseProps(), ...overrides };
  render(<ProjectSwitcherPalette {...props} />);
  return props;
}

/**
 * The Scratch section's collapse toggle, which doubles as the context-menu trigger.
 * Keyed on `aria-controls` rather than the accessible name: the name absorbs the
 * count badge ("Scratch2"), so it shifts with the fixture.
 */
function scratchHeader(): HTMLElement {
  const header = document.querySelector<HTMLElement>(
    'button[aria-controls="scratch-section-list"]'
  );
  if (!header) throw new Error("Scratch section header not found");
  return header;
}

function deleteAllItem(): HTMLElement | null {
  return screen.queryByRole("menuitem", { name: /delete all scratch workspaces/i });
}

function snapshotOf(count: number): DeleteAllScratchesSnapshot {
  return Array.from({ length: count }, (_, i) => ({ id: `scratch-${i}`, name: `Spike ${i}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Scratch section header context menu", () => {
  it("offers the bulk delete once scratches exist", () => {
    renderPalette({ scratchResults: [makeScratch(1), makeScratch(2)] });

    fireEvent.contextMenu(scratchHeader());

    expect(deleteAllItem()).not.toBeNull();
  });

  it("offers nothing to delete when the section is empty", () => {
    renderPalette({ scratchResults: [] });

    fireEvent.contextMenu(scratchHeader());

    // "Delete all" of nothing is a confirm dialog reading "Delete 0 scratch
    // workspaces?" — the action has to be absent, not merely inert.
    expect(deleteAllItem()).toBeNull();
  });

  it("does not collapse the section when the menu is opened", () => {
    renderPalette({ scratchResults: [makeScratch(1)] });
    const header = scratchHeader();

    fireEvent.contextMenu(header);

    // The trigger is the collapse toggle. If the right-click also reached its
    // onClick, the section would snap shut under the menu it just opened.
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(deleteAllItem()).not.toBeNull();
  });

  it("still collapses the section on an ordinary click", () => {
    renderPalette({ scratchResults: [makeScratch(1)] });
    const header = scratchHeader();

    fireEvent.click(header);

    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("asks the host to open the confirmation when the item is chosen", () => {
    const props = renderPalette({ scratchResults: [makeScratch(1), makeScratch(2)] });

    fireEvent.contextMenu(scratchHeader());
    const item = deleteAllItem();
    expect(item).not.toBeNull();
    fireEvent.click(item!);

    // The palette never deletes anything itself — it requests the confirm.
    expect(props.onRequestDeleteAllScratches).toHaveBeenCalledTimes(1);
    expect(props.onRemoveScratch).not.toHaveBeenCalled();
  });

  it("hides the bulk delete when the host wires no handler", () => {
    renderPalette({
      scratchResults: [makeScratch(1)],
      onRequestDeleteAllScratches: undefined,
    });

    fireEvent.contextMenu(scratchHeader());

    expect(deleteAllItem()).toBeNull();
  });
});

describe("Bulk delete confirmation", () => {
  it("counts the frozen snapshot, not the live scratch list", () => {
    // The list has already shrunk to one as removals land; the dialog must keep
    // naming the three the user actually agreed to.
    renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshotOf(3),
    });

    expect(screen.getByTestId("confirm-title").textContent).toContain("3");
  });

  it("agrees in number with a single target", () => {
    renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshotOf(1),
    });

    const title = screen.getByTestId("confirm-title").textContent ?? "";
    expect(title).toMatch(/1 scratch workspace\?/);
    expect(title).not.toMatch(/workspaces/);
  });

  it("pluralizes for several targets", () => {
    renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshotOf(4),
    });

    expect(screen.getByTestId("confirm-title").textContent).toMatch(/4 scratch workspaces\?/);
  });

  it("stays closed when nothing is pending", () => {
    renderPalette({ scratchResults: [makeScratch(1)], deleteAllScratchesConfirm: null });

    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  });

  it("gates the delete behind a destructive dialog with no typed-name step", () => {
    renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshotOf(2),
    });

    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog.getAttribute("data-variant")).toBe("destructive");
    // D1, not D2: scratches are local throwaway workspaces, so the count carries
    // the consent — a typed-name gate here would be friction without a payoff.
    expect(dialog.getAttribute("data-typed-name-target")).toBe("");
  });

  it("runs the deletion when confirmed", () => {
    const props = renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshotOf(2),
    });

    fireEvent.click(screen.getByRole("button", { name: /^delete scratch workspaces$/i }));

    expect(props.onConfirmDeleteAllScratches).toHaveBeenCalledTimes(1);
  });

  it("dismisses without deleting when cancelled", () => {
    const props = renderPalette({
      scratchResults: [makeScratch(1)],
      deleteAllScratchesConfirm: snapshotOf(2),
    });

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(props.onDismissDeleteAllScratchesConfirm).toHaveBeenCalledTimes(1);
    expect(props.onConfirmDeleteAllScratches).not.toHaveBeenCalled();
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

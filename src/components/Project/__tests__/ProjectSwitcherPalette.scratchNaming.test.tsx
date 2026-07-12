/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

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
  const Header = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="palette-header">{children}</div>
  );
  const Input = ({
    inputRef,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    inputRef?: React.Ref<HTMLInputElement>;
  }) => <input ref={inputRef} data-testid="palette-input" {...props} />;
  const Body = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="palette-body">{children}</div>
  );
  const Footer = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="palette-footer">{children}</div>
  );

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

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

// Renders context-menu items inline as buttons so `onSelect` is reachable without
// driving Radix's pointer/focus machinery.
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => null,
}));

vi.mock("@/hooks/useModifierKeys", () => ({
  useModifierKeys: () => ({ meta: false, alt: false }),
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: () => "1h ago",
}));

import type { SearchableScratch } from "@/hooks/useProjectSwitcherPalette";
import { defaultScratchName } from "@shared/utils/scratchName";

const { ProjectSwitcherPalette } = await import("../ProjectSwitcherPalette");

function makeScratch(overrides: Partial<SearchableScratch> = {}): SearchableScratch {
  return {
    id: "scratch-1",
    name: "Scratch 2026-01-01 09:00",
    path: "/tmp/scratches/scratch-1",
    createdAt: Date.now(),
    lastOpened: Date.now(),
    isActive: false,
    ...overrides,
  };
}

function renderPalette(overrides: Record<string, unknown> = {}) {
  const props = {
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
    ...overrides,
  };
  render(<ProjectSwitcherPalette {...props} />);
  expandScratchSection();
  return props;
}

/**
 * The section auto-collapses when there are no scratches yet, hiding its contents.
 * Matched by aria-controls: the header's accessible name absorbs the count badge.
 */
function expandScratchSection() {
  const header = document.querySelector('[aria-controls="scratch-section-list"]');
  if (header instanceof HTMLElement && header.getAttribute("aria-expanded") === "false") {
    fireEvent.click(header);
  }
}

describe("scratch create naming", () => {
  it("swaps the create button for a focused, fully-selected input", () => {
    renderPalette();
    fireEvent.click(screen.getByTestId("scratch-create-button"));

    const input = screen.getByTestId<HTMLInputElement>("scratch-create-input");
    expect(screen.queryByTestId("scratch-create-button")).toBeNull();
    expect(document.activeElement).toBe(input);
    // Fully selected, so typing replaces the prefill outright.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("prefills the name main would otherwise assign", () => {
    renderPalette();
    fireEvent.click(screen.getByTestId("scratch-create-button"));

    const input = screen.getByTestId<HTMLInputElement>("scratch-create-input");
    expect(input.value).toBe(defaultScratchName(new Date()));
  });

  it("creates with the typed name on Enter", () => {
    const props = renderPalette();
    fireEvent.click(screen.getByTestId("scratch-create-button"));

    const input = screen.getByTestId("scratch-create-input");
    fireEvent.change(input, { target: { value: "Retry queue spike" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(props.onCreateScratch).toHaveBeenCalledWith("Retry queue spike");
  });

  it("forwards the untouched prefill when the user just hits Enter", () => {
    const props = renderPalette();
    fireEvent.click(screen.getByTestId("scratch-create-button"));

    const input = screen.getByTestId<HTMLInputElement>("scratch-create-input");
    const prefill = input.value;
    fireEvent.keyDown(input, { key: "Enter" });

    expect(props.onCreateScratch).toHaveBeenCalledWith(prefill);
  });

  it("still creates when the name is cleared — main owns the empty-name fallback", () => {
    const props = renderPalette();
    fireEvent.click(screen.getByTestId("scratch-create-button"));

    const input = screen.getByTestId("scratch-create-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(props.onCreateScratch).toHaveBeenCalledTimes(1);
    expect(props.onCreateScratch).toHaveBeenCalledWith("   ");
  });

  it("cancels on Escape without creating, and restores the create button", () => {
    const props = renderPalette();
    fireEvent.click(screen.getByTestId("scratch-create-button"));

    const input = screen.getByTestId("scratch-create-input");
    fireEvent.change(input, { target: { value: "Abandoned" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(props.onCreateScratch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("scratch-create-input")).toBeNull();
    expect(screen.getByTestId("scratch-create-button")).toBeTruthy();
  });

  it("does not close the palette when Escape cancels the edit", () => {
    const props = renderPalette();
    fireEvent.click(screen.getByTestId("scratch-create-button"));
    fireEvent.keyDown(screen.getByTestId("scratch-create-input"), { key: "Escape" });

    // The palette's own Escape backstop must not see this keystroke.
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("cancels on blur rather than creating something the user clicked away from", () => {
    const props = renderPalette();
    fireEvent.click(screen.getByTestId("scratch-create-button"));

    const input = screen.getByTestId("scratch-create-input");
    fireEvent.change(input, { target: { value: "Half typed" } });
    fireEvent.blur(input);

    expect(props.onCreateScratch).not.toHaveBeenCalled();
    expect(screen.getByTestId("scratch-create-button")).toBeTruthy();
  });

  it("ignores Enter while an IME composition is active", () => {
    const props = renderPalette();
    fireEvent.click(screen.getByTestId("scratch-create-button"));

    const input = screen.getByTestId("scratch-create-input");
    fireEvent.change(input, { target: { value: "にほんご" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(props.onCreateScratch).not.toHaveBeenCalled();
  });

  it("leaves project navigation alone while the editor owns focus", () => {
    const props = renderPalette();
    fireEvent.click(screen.getByTestId("scratch-create-button"));

    const input = screen.getByTestId("scratch-create-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });

    expect(props.onSelectNext).not.toHaveBeenCalled();
    expect(props.onSelectPrevious).not.toHaveBeenCalled();
  });
});

describe("scratch rename", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces only the targeted row with an editor", () => {
    const scratches = [
      makeScratch({ id: "a", name: "Alpha" }),
      makeScratch({ id: "b", name: "Beta" }),
    ];
    renderPalette({ scratchResults: scratches });

    const renameButtons = screen.getAllByText("Rename scratch");
    act(() => {
      fireEvent.click(renameButtons[0]!);
    });

    const inputs = screen.getAllByTestId<HTMLInputElement>("scratch-rename-input");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.value).toBe("Alpha");
    // The untouched row keeps rendering normally.
    expect(screen.getByText("Beta")).toBeTruthy();
  });

  it("renames with the trimmed value on Enter", () => {
    const props = renderPalette({ scratchResults: [makeScratch({ id: "a", name: "Alpha" })] });
    act(() => {
      fireEvent.click(screen.getByText("Rename scratch"));
    });

    const input = screen.getByTestId("scratch-rename-input");
    fireEvent.change(input, { target: { value: "  Renamed  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(props.onRenameScratch).toHaveBeenCalledWith("a", "Renamed");
  });

  it("does not hit IPC when the name is unchanged", () => {
    const props = renderPalette({ scratchResults: [makeScratch({ id: "a", name: "Alpha" })] });
    act(() => {
      fireEvent.click(screen.getByText("Rename scratch"));
    });

    fireEvent.keyDown(screen.getByTestId("scratch-rename-input"), { key: "Enter" });

    expect(props.onRenameScratch).not.toHaveBeenCalled();
  });

  it("does not hit IPC when the name is cleared", () => {
    const props = renderPalette({ scratchResults: [makeScratch({ id: "a", name: "Alpha" })] });
    act(() => {
      fireEvent.click(screen.getByText("Rename scratch"));
    });

    const input = screen.getByTestId("scratch-rename-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(props.onRenameScratch).not.toHaveBeenCalled();
  });

  it("reverts on Escape and restores the row", () => {
    const props = renderPalette({ scratchResults: [makeScratch({ id: "a", name: "Alpha" })] });
    act(() => {
      fireEvent.click(screen.getByText("Rename scratch"));
    });

    const input = screen.getByTestId("scratch-rename-input");
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(props.onRenameScratch).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("selecting a row is not triggered by opening its rename editor", () => {
    const props = renderPalette({ scratchResults: [makeScratch({ id: "a", name: "Alpha" })] });
    act(() => {
      fireEvent.click(screen.getByText("Rename scratch"));
    });

    expect(props.onSelectScratch).not.toHaveBeenCalled();
  });

  it("offers no rename affordance when the host wires no handler", () => {
    renderPalette({
      scratchResults: [makeScratch({ id: "a", name: "Alpha" })],
      onRenameScratch: undefined,
    });

    expect(screen.queryByText("Rename scratch")).toBeNull();
  });
});

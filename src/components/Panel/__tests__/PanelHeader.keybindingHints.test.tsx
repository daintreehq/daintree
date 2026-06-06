// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { PanelHeader } from "../PanelHeader";
import type { PanelHeaderProps } from "../PanelHeader";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { keybindingService } from "@/services/KeybindingService";

// Real useKeybindingDisplay + useAriaKeyshortcuts so the rebind path can be
// observed through the real useSyncExternalStore subscription. The sibling
// test file (PanelHeader.test.tsx) mocks these to empty strings, which is
// fine for chrome tests but defeats the entire purpose of this file.
vi.mock("@/hooks", async () => {
  const actual = await vi.importActual<typeof import("@/hooks")>("@/hooks");
  return {
    ...actual,
    useBackgroundPanelStats: () => ({ activeCount: 0, workingCount: 0 }),
    useTabOverflow: () => new Set<string>(),
  };
});

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

vi.mock("framer-motion", () => {
  const passthrough = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => {
      const {
        layoutId: _layoutId,
        layout: _layout,
        transition: _transition,
        ...rest
      } = props as Record<string, unknown>;
      return (
        <div ref={ref} {...(rest as React.HTMLAttributes<HTMLDivElement>)}>
          {children}
        </div>
      );
    }
  );
  return {
    AnimatePresence: passthrough,
    LayoutGroup: passthrough,
    LazyMotion: passthrough,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv },
    motion: { div: MotionDiv },
  };
});

const mockDragHandle: {
  listeners: Record<string, (e: unknown) => void> | undefined;
  setActivatorNodeRef?: (node: HTMLElement | null) => void;
} | null = null;

vi.mock("@/components/DragDrop/DragHandleContext", () => ({
  useDragHandle: () => mockDragHandle,
}));

let mockStoreState: Record<string, unknown> = {
  watchedPanels: new Set<string>(),
  watchPanel: vi.fn(),
  unwatchPanel: vi.fn(),
  panelsById: {} as Record<string, unknown>,
  panelIds: [] as string[],
};

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockStoreState),
}));

vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindCanRestart: () => mockCanRestart,
  panelKindHasPty: () => mockHasPty,
  getPanelKindConfig: () => ({
    id: "terminal",
    name: "Terminal",
    iconId: "terminal",
    color: "#9ca3af",
  }),
  getPanelKindColor: () => "#9ca3af",
}));

let mockCanRestart = true;
let mockHasPty = true;

const mockDispatch = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => mockDispatch(...args) },
}));

vi.mock("@/lib/watchNotification", () => ({
  fireWatchNotification: vi.fn(),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { className?: string; children: React.ReactNode }) => (
    <div data-testid="overflow-menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    destructive,
    ...rest
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    destructive?: boolean;
    [key: string]: unknown;
  }) => (
    <button
      data-destructive={destructive || undefined}
      {...rest}
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

function makeProps(overrides: Partial<PanelHeaderProps> = {}): PanelHeaderProps {
  const chrome =
    overrides.chrome ??
    deriveTerminalChrome({
      kind: overrides.kind ?? "terminal",
      presetColor: overrides.presetColor,
    });
  return {
    id: "test-panel",
    title: "Test Panel",
    kind: "terminal",
    chrome,
    isFocused: true,
    isEditingTitle: false,
    editingValue: "",
    titleInputRef: { current: null },
    onEditingValueChange: vi.fn(),
    onTitleDoubleClick: vi.fn(),
    onTitleKeyDown: vi.fn(),
    onTitleInputKeyDown: vi.fn(),
    onTitleSave: vi.fn(),
    onClose: vi.fn(),
    onFocus: vi.fn(),
    onRestart: vi.fn(),
    ...overrides,
  };
}

function stubElectronKeybinding() {
  // setOverride is a silent no-op unless `window.electron.keybinding` exists.
  // Stubbing it makes the override land in the service's `overrides` map and
  // notify listeners, which is what exercises the rebind path end-to-end.
  vi.stubGlobal("window", {
    electron: {
      keybinding: {
        setOverride: vi.fn().mockResolvedValue(undefined),
        removeOverride: vi.fn().mockResolvedValue(undefined),
        getOverrides: vi.fn().mockResolvedValue({}),
        resetAll: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
}

const RECOVERY_ACTION_IDS = [
  "terminal.kill",
  "terminal.restart",
  "terminal.forceResume",
  "terminal.redraw",
  "terminal.rename",
] as const;

describe("PanelHeader terminal recovery chord hints — issue #9803", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // KbdChord and getDisplayCombo both branch on `isMac()` to render ⌘/Ctrl
    // glyphs. Pin the platform so the assertions below match the Mac defaults
    // the issue calls out (⌘ glyph + the letter), regardless of the host OS
    // the test happens to run on.
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "MacIntel" },
      configurable: true,
      writable: true,
    });
    mockCanRestart = true;
    mockHasPty = true;
    mockStoreState = {
      watchedPanels: new Set<string>(),
      watchPanel: vi.fn(),
      unwatchPanel: vi.fn(),
      panelsById: {},
      panelIds: [],
    };
  });

  afterEach(async () => {
    // Clean up any rebind state so sibling tests start with defaults.
    for (const id of RECOVERY_ACTION_IDS) {
      await act(async () => {
        await keybindingService.removeOverride(id);
      });
    }
    vi.unstubAllGlobals();
  });

  it("renders the hint row with all five recovery chord pills at default", () => {
    render(<PanelHeader {...makeProps()} />);

    expect(screen.getByTestId("panel-hint-row")).toBeDefined();
    expect(screen.getByTestId("panel-hint-terminal-kill")).toBeDefined();
    expect(screen.getByTestId("panel-hint-terminal-restart")).toBeDefined();
    expect(screen.getByTestId("panel-hint-terminal-force-resume")).toBeDefined();
    expect(screen.getByTestId("panel-hint-terminal-redraw")).toBeDefined();
    expect(screen.getByTestId("panel-hint-terminal-rename")).toBeDefined();
  });

  it("renders Mac glyphs (⌘ + K + letter) in the default pill text", () => {
    render(<PanelHeader {...makeProps()} />);
    const kill = screen.getByTestId("panel-hint-terminal-kill");
    expect(kill.textContent).toContain("⌘");
    expect(kill.textContent.toUpperCase()).toContain("K");
    expect(kill.textContent.toUpperCase()).toContain("Q");
  });

  it("uses the dynamic useKeybindingDisplay hook so the rebind path is automatic", async () => {
    stubElectronKeybinding();

    const { rerender } = render(<PanelHeader {...makeProps()} />);
    const killBefore = screen.getByTestId("panel-hint-terminal-kill");
    const rowBefore = screen.getByTestId("panel-hint-row");
    const textBefore = killBefore.textContent ?? "";
    expect(textBefore).toContain("Q");

    await act(async () => {
      await keybindingService.setOverride("terminal.kill", ["Cmd+Shift+K"]);
    });
    rerender(<PanelHeader {...makeProps()} />);

    // Same DOM nodes — useSyncExternalStore re-renders in place, not remount.
    expect(screen.getByTestId("panel-hint-row")).toBe(rowBefore);
    expect(screen.getByTestId("panel-hint-terminal-kill")).toBe(killBefore);

    const killAfter = screen.getByTestId("panel-hint-terminal-kill");
    const textAfter = killAfter.textContent ?? "";
    expect(textAfter).not.toBe(textBefore);
    expect(textAfter).toContain("⌘");
    expect(textAfter).toContain("⇧");
    expect(textAfter.toUpperCase()).toContain("K");
    expect(textAfter).not.toContain("Q");
  });

  it("hides the hint row entirely when every chord is unbound (Windows no-override scenario)", async () => {
    stubElectronKeybinding();
    for (const id of RECOVERY_ACTION_IDS) {
      await act(async () => {
        await keybindingService.setOverride(id, []);
      });
    }
    render(<PanelHeader {...makeProps()} />);
    expect(screen.queryByTestId("panel-hint-row")).toBeNull();
  });

  it("hides a single pill when only that chord is unbound, but keeps the row", async () => {
    stubElectronKeybinding();
    await act(async () => {
      await keybindingService.setOverride("terminal.kill", []);
    });
    render(<PanelHeader {...makeProps()} />);

    expect(screen.getByTestId("panel-hint-row")).toBeDefined();
    expect(screen.queryByTestId("panel-hint-terminal-kill")).toBeNull();
    expect(screen.getByTestId("panel-hint-terminal-restart")).toBeDefined();
    expect(screen.getByTestId("panel-hint-terminal-redraw")).toBeDefined();
    expect(screen.getByTestId("panel-hint-terminal-force-resume")).toBeDefined();
    expect(screen.getByTestId("panel-hint-terminal-rename")).toBeDefined();
  });

  it("does not render the hint row on non-PTY panel kinds (#9803 review)", () => {
    // Every action in the row requires a PTY. ContentPanel mounts the same
    // PanelHeader for browser/dev-preview/review panels; without a hasPty
    // guard, those headers would advertise terminal recovery chords and a
    // stray press would route through `removePanel(focusedId)`.
    mockHasPty = false;
    render(<PanelHeader {...makeProps()} />);
    expect(screen.queryByTestId("panel-hint-row")).toBeNull();
    expect(screen.queryByTestId("panel-hint-terminal-kill")).toBeNull();
    expect(screen.queryByTestId("panel-hint-terminal-restart")).toBeNull();
    expect(screen.queryByTestId("panel-hint-terminal-force-resume")).toBeNull();
    expect(screen.queryByTestId("panel-hint-terminal-redraw")).toBeNull();
    expect(screen.queryByTestId("panel-hint-terminal-rename")).toBeNull();
  });
});

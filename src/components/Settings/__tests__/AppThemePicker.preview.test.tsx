// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: {
    setColorScheme: vi.fn().mockResolvedValue(undefined),
    setFollowSystem: vi.fn().mockResolvedValue(undefined),
    setCustomSchemes: vi.fn().mockResolvedValue(undefined),
    setRecentSchemeIds: vi.fn().mockResolvedValue(undefined),
    importTheme: vi.fn().mockResolvedValue({ ok: false, errors: ["Import cancelled"] }),
    exportTheme: vi.fn().mockResolvedValue(undefined),
  },
}));

const storeState: Record<string, unknown> = {};

vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
    {
      getState: () => storeState,
    }
  ),
  injectSchemeToDOM: vi.fn(),
}));

vi.mock("@/lib/appThemeViewTransition", () => ({
  prefersReducedMotion: () => true,
  runThemeReveal: (_origin: unknown, commit: () => void) => {
    commit();
  },
}));

vi.mock("@/config/appColorSchemes", () => {
  const mkTheme = (id: string, name: string, accent: string) => ({
    id,
    name,
    type: "dark" as const,
    tokens: {
      "--canopy-accent": accent,
      "--canopy-success": "#0f0",
      "--canopy-warning": "#ff0",
      "--canopy-danger": "#f00",
      "--canopy-text": "#fff",
      "--canopy-border": "#333",
      "--canopy-panel": "#111",
      "--canopy-sidebar": "#222",
      "--canopy-bg": "#000",
    },
  });
  return {
    BUILT_IN_APP_SCHEMES: [
      mkTheme("theme-a", "Theme A", "#f00"),
      mkTheme("theme-b", "Theme B", "#00f"),
      mkTheme("theme-c", "Theme C", "#0ff"),
    ],
  };
});

vi.mock("@shared/theme", () => ({
  APP_THEME_PREVIEW_KEYS: {
    accent: "--canopy-accent",
    success: "--canopy-success",
    warning: "--canopy-warning",
    danger: "--canopy-danger",
    text: "--canopy-text",
    border: "--canopy-border",
    panel: "--canopy-panel",
    sidebar: "--canopy-sidebar",
    background: "--canopy-bg",
  },
  getAppThemeWarnings: () => [],
  applyAccentOverrideToScheme: (scheme: unknown) => scheme,
  resolveAppTheme: (id: string, customSchemes: { id: string }[]) => {
    const map: Record<string, { id: string; name: string; type: string; tokens: object }> = {
      "theme-a": { id: "theme-a", name: "Theme A", type: "dark", tokens: {} },
      "theme-b": { id: "theme-b", name: "Theme B", type: "dark", tokens: {} },
      "theme-c": { id: "theme-c", name: "Theme C", type: "dark", tokens: {} },
    };
    return map[id] ?? customSchemes.find((s) => s.id === id);
  },
}));

// AppDialog renders children inline with an onClose handler exposed via the
// close button, keeping the test focused on picker logic.
vi.mock("@/components/ui/AppDialog", () => {
  const AppDialog = ({
    isOpen,
    onClose,
    children,
  }: {
    isOpen: boolean;
    onClose: () => void;
    children: React.ReactNode;
  }) => {
    if (!isOpen) return null;
    return (
      <div data-testid="theme-picker-dialog">
        <button type="button" data-testid="dialog-close" onClick={onClose}>
          close
        </button>
        {children}
      </div>
    );
  };
  AppDialog.Header = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  AppDialog.Title = ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => null;
  AppDialog.BodyScroll = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { AppDialog };
});

vi.mock("@/hooks/useEscapeStack", () => ({
  useEscapeStack: vi.fn(),
}));

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: vi.fn(() => ({ isVisible: true, shouldRender: true })),
}));

vi.mock("@/hooks", () => ({
  useOverlayState: vi.fn(),
  useEscapeStack: vi.fn(),
}));

vi.mock("@/store", () => ({
  usePortalStore: vi.fn(() => ({ isOpen: false, width: 0 })),
}));

import { AppThemePicker } from "../AppThemePicker";

let pendingRaf: Array<{ handle: number; cb: FrameRequestCallback }> = [];
let nextHandle = 0;
const flushRaf = () => {
  act(() => {
    const pending = pendingRaf;
    pendingRaf = [];
    for (const entry of pending) entry.cb(0);
  });
};

describe("AppThemePicker hover preview", () => {
  beforeEach(() => {
    pendingRaf = [];
    nextHandle = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      nextHandle += 1;
      pendingRaf.push({ handle: nextHandle, cb });
      return nextHandle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      pendingRaf = pendingRaf.filter((entry) => entry.handle !== handle);
    });

    Object.assign(storeState, {
      selectedSchemeId: "theme-a",
      customSchemes: [],
      recentSchemeIds: [],
      followSystem: false,
      preferredDarkSchemeId: "theme-a",
      preferredLightSchemeId: "theme-a",
      setSelectedSchemeId: vi.fn(),
      commitSchemeSelection: vi.fn(),
      setSelectedSchemeIdSilent: vi.fn(),
      injectTheme: vi.fn(),
      setFollowSystem: vi.fn(),
      setPreferredDarkSchemeId: vi.fn(),
      setPreferredLightSchemeId: vi.fn(),
      setRecentSchemeIds: vi.fn(),
      addCustomScheme: vi.fn(),
      accentColorOverride: null,
      setAccentColorOverride: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const openDialog = () => {
    fireEvent.click(screen.getByTestId("theme-picker-trigger"));
  };

  it("calls injectTheme with the hovered scheme on pointer enter", () => {
    render(<AppThemePicker />);
    openDialog();

    const injectTheme = storeState.injectTheme as ReturnType<typeof vi.fn>;
    injectTheme.mockClear();

    const cardB = screen.getAllByRole("option").find((o) => o.textContent?.includes("Theme B"))!;
    fireEvent.pointerEnter(cardB);

    expect(injectTheme).toHaveBeenCalledTimes(1);
    expect((injectTheme.mock.calls[0][0] as { id: string }).id).toBe("theme-b");
  });

  it("reverts to the committed theme on pointer leave via rAF", () => {
    render(<AppThemePicker />);
    openDialog();

    const injectTheme = storeState.injectTheme as ReturnType<typeof vi.fn>;
    const cardB = screen.getAllByRole("option").find((o) => o.textContent?.includes("Theme B"))!;
    fireEvent.pointerEnter(cardB);
    injectTheme.mockClear();

    fireEvent.pointerLeave(cardB);
    expect(injectTheme).not.toHaveBeenCalled();

    flushRaf();

    expect(injectTheme).toHaveBeenCalledTimes(1);
    // Reverts to the committed selection (theme-a).
    expect((injectTheme.mock.calls[0][0] as { id: string }).id).toBe("theme-a");
  });

  it("click commits via commitSchemeSelection without closing the modal", () => {
    render(<AppThemePicker />);
    openDialog();

    expect(screen.queryByTestId("theme-picker-dialog")).not.toBeNull();

    const cardB = screen.getAllByRole("option").find((o) => o.textContent?.includes("Theme B"))!;
    fireEvent.click(cardB);

    const commitSchemeSelection = storeState.commitSchemeSelection as ReturnType<typeof vi.fn>;
    expect(commitSchemeSelection).toHaveBeenCalledWith("theme-b");
    // Modal should still be mounted.
    expect(screen.queryByTestId("theme-picker-dialog")).not.toBeNull();
  });

  it("closing the dialog reverts to the origin theme captured on open", () => {
    render(<AppThemePicker />);
    openDialog();

    const injectTheme = storeState.injectTheme as ReturnType<typeof vi.fn>;
    // Simulate hover previewing a different card prior to close so we can see
    // the origin revert fire with the right scheme id.
    const cardB = screen.getAllByRole("option").find((o) => o.textContent?.includes("Theme B"))!;
    fireEvent.pointerEnter(cardB);
    injectTheme.mockClear();

    fireEvent.click(screen.getByTestId("dialog-close"));

    // The close handler calls injectTheme(originScheme).
    expect(injectTheme).toHaveBeenCalled();
    const lastCall = injectTheme.mock.calls[injectTheme.mock.calls.length - 1][0] as {
      id: string;
    };
    expect(lastCall.id).toBe("theme-a");
    // Dialog is no longer mounted.
    expect(screen.queryByTestId("theme-picker-dialog")).toBeNull();
  });

  it("after a committed selection, close syncs DOM to the committed theme (not the origin)", () => {
    const { rerender } = render(<AppThemePicker />);
    openDialog();

    const injectTheme = storeState.injectTheme as ReturnType<typeof vi.fn>;

    // Simulate a click-commit updating the store's selectedSchemeId.
    storeState.selectedSchemeId = "theme-c";
    rerender(<AppThemePicker />);
    injectTheme.mockClear();

    fireEvent.click(screen.getByTestId("dialog-close"));

    expect(injectTheme).toHaveBeenCalledTimes(1);
    expect((injectTheme.mock.calls[0][0] as { id: string }).id).toBe("theme-c");
  });

  it("handles the pending-revert + click-commit + close race without re-injecting the origin", () => {
    const { rerender } = render(<AppThemePicker />);
    openDialog();

    const injectTheme = storeState.injectTheme as ReturnType<typeof vi.fn>;
    const commitSchemeSelection = storeState.commitSchemeSelection as ReturnType<typeof vi.fn>;

    const cardB = screen.getAllByRole("option").find((o) => o.textContent?.includes("Theme B"))!;

    // Hover B, then leave B — a revert rAF is now queued but not yet flushed.
    fireEvent.pointerEnter(cardB);
    fireEvent.pointerLeave(cardB);
    expect(pendingRaf.length).toBe(1);

    // User clicks B to commit before the rAF fires.
    fireEvent.click(cardB);
    expect(commitSchemeSelection).toHaveBeenCalledWith("theme-b");

    // Simulate the store state update that the real commitSchemeSelection would
    // perform so the subsequent close handler reads the committed value.
    storeState.selectedSchemeId = "theme-b";
    rerender(<AppThemePicker />);

    injectTheme.mockClear();

    // Flush the pending revert rAF that was queued on pointerLeave before the
    // click. It should revert to the currently committed scheme, not the
    // pre-commit origin.
    flushRaf();

    const revertCallIds = injectTheme.mock.calls.map(
      (call: unknown[]) => (call[0] as { id: string }).id
    );
    // Origin theme-a should NOT be re-injected.
    expect(revertCallIds).not.toContain("theme-a");

    injectTheme.mockClear();
    fireEvent.click(screen.getByTestId("dialog-close"));

    // Closing should sync DOM to the committed theme-b, never the origin.
    expect(injectTheme).toHaveBeenCalledTimes(1);
    expect((injectTheme.mock.calls[0][0] as { id: string }).id).toBe("theme-b");
  });

  it("unmount cleanup restores DOM to the committed theme", () => {
    const { unmount } = render(<AppThemePicker />);
    openDialog();

    const injectTheme = storeState.injectTheme as ReturnType<typeof vi.fn>;
    const cardB = screen.getAllByRole("option").find((o) => o.textContent?.includes("Theme B"))!;
    fireEvent.pointerEnter(cardB);

    injectTheme.mockClear();
    unmount();

    // Unmount should have triggered a committed-theme re-inject so the preview
    // does not leak into the chrome after a tab switch.
    expect(injectTheme).toHaveBeenCalled();
    const lastId = (injectTheme.mock.calls[injectTheme.mock.calls.length - 1][0] as { id: string })
      .id;
    expect(lastId).toBe("theme-a");
  });

  it("updates the aria-live region with the previewed theme name", () => {
    const { container } = render(<AppThemePicker />);
    openDialog();

    const cardB = screen.getAllByRole("option").find((o) => o.textContent?.includes("Theme B"))!;
    fireEvent.pointerEnter(cardB);

    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe("Previewing: Theme B");

    fireEvent.pointerLeave(cardB);
    flushRaf();
    expect(live?.textContent).toBe("");
  });
});

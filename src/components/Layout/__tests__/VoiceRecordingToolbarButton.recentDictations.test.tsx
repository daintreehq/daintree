// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { RecentDictation } from "@shared/types";
import { VoiceRecordingToolbarButton } from "../VoiceRecordingToolbarButton";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useRecentDictationsStore } from "@/store/recentDictationsStore";
import { usePaletteStore } from "@/store/paletteStore";

const dispatch = vi.fn();
const recovery = vi.hoisted(() => ({
  insertRecentDictation: vi.fn<(d: RecentDictation, version?: string) => string | null>(),
  copyRecentDictation: vi.fn<(d: RecentDictation, version?: string) => void>(),
  focusRecoveredComposer: vi.fn<(panelId: string) => void>(),
}));
// The menu's opening and close hand focus around; the test plays both.
const menu = vi.hoisted(() => ({
  onCloseAutoFocus: null as ((e: Event) => void) | null,
  onOpenChange: null as ((open: boolean) => void) | null,
}));

vi.mock("@/services/VoiceRecordingService", () => ({
  voiceRecordingService: { focusActiveTarget: vi.fn(), togglePause: vi.fn() },
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatch(...args) },
}));
vi.mock("@/services/recentDictationRecovery", () => recovery);
vi.mock("@/hooks", () => ({
  useEffectiveCombo: () => undefined,
  useShortcutHintHover: () => ({}),
}));
vi.mock("@/lib/appThemeViewTransition", () => ({ prefersReducedMotion: () => true }));
vi.mock("../ToolbarContextMenuItems", () => ({ ToolbarContextMenuItems: () => null }));
vi.mock("@/components/ui/TimeAgo", () => ({ TimeAgo: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
// Every menu part rendered inline, so the items can be read and picked.
vi.mock("@/components/ui/context-menu", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    ContextMenu: ({
      children,
      onOpenChange,
    }: {
      children?: React.ReactNode;
      onOpenChange?: (open: boolean) => void;
    }) => {
      menu.onOpenChange = onOpenChange ?? null;
      return <>{children}</>;
    },
    ContextMenuTrigger: Pass,
    ContextMenuSub: Pass,
    ContextMenuSubContent: Pass,
    ContextMenuSubTrigger: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="dictation-entry">{children}</div>
    ),
    ContextMenuContent: ({
      children,
      onCloseAutoFocus,
    }: {
      children?: React.ReactNode;
      onCloseAutoFocus?: (e: Event) => void;
    }) => {
      menu.onCloseAutoFocus = onCloseAutoFocus ?? null;
      return <div data-testid="menu">{children}</div>;
    },
    ContextMenuItem: ({
      children,
      onSelect,
    }: {
      children?: React.ReactNode;
      onSelect?: () => void;
    }) => (
      <button type="button" role="menuitem" onClick={onSelect}>
        {children}
      </button>
    ),
    ContextMenuLabel: Pass,
    ContextMenuMeta: Pass,
    ContextMenuSeparator: () => null,
  };
});

const CLEANED: RecentDictation = {
  id: "s2",
  rawText: "ship the lexr fix",
  correctedText: "Ship the lexer fix.",
  target: { panelId: "p2", panelTitle: "Codex" },
  endedAt: 2,
};
const RAW_ONLY: RecentDictation = {
  id: "s1",
  rawText: "first paragraph\nsecond paragraph",
  correctedText: null,
  target: { panelId: "p1", panelTitle: "Claude" },
  endedAt: 1,
};

const item = (name: string, within: ParentNode = document) =>
  [...within.querySelectorAll('[role="menuitem"]')].filter((el) => el.textContent === name);
const entries = () => [...document.querySelectorAll('[data-testid="dictation-entry"]')];

describe("VoiceRecordingToolbarButton — recent dictations (#14637)", () => {
  beforeEach(() => {
    dispatch.mockClear();
    recovery.insertRecentDictation.mockReset().mockReturnValue("p9");
    recovery.copyRecentDictation.mockReset();
    recovery.focusRecoveredComposer.mockReset();
    menu.onCloseAutoFocus = null;
    menu.onOpenChange = null;
    useVoiceRecordingStore.setState({
      status: "idle",
      activeTarget: null,
      pendingTarget: null,
      lockedTarget: null,
    });
    useRecentDictationsStore.getState().setDictations([CLEANED, RAW_ONLY]);
  });

  afterEach(() => {
    cleanup();
    useRecentDictationsStore.getState().setDictations([]);
  });

  it("keeps the idle slot an empty placeholder until there is something to recover", () => {
    useRecentDictationsStore.getState().setDictations([]);
    const { container } = render(<VoiceRecordingToolbarButton />);

    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("shows a history button once a dictation has finished, which opens the list", () => {
    const { getByTestId } = render(<VoiceRecordingToolbarButton data-toolbar-item="" />);

    fireEvent.click(getByTestId("voice-history-button"));
    expect(dispatch).toHaveBeenCalledWith("voiceInput.openRecentDictations", undefined, {
      source: "user",
    });
  });

  it("offers each dictation's text, and the original only where cleanup changed it", () => {
    render(<VoiceRecordingToolbarButton />);

    expect(entries().map((el) => el.textContent)).toEqual([
      "Ship the lexer fix.",
      "first paragraph second paragraph",
    ]);
    expect(item("Add original to draft")).toHaveLength(1);
    expect(item("Copy original")).toHaveLength(1);

    fireEvent.click(item("Copy original")[0]!);
    expect(recovery.copyRecentDictation).toHaveBeenCalledWith(CLEANED, "original");
    fireEvent.click(item("Copy")[1]!);
    expect(recovery.copyRecentDictation).toHaveBeenLastCalledWith(RAW_ONLY);
  });

  it("gives the composer the keyboard after an add, instead of the toolbar", () => {
    render(<VoiceRecordingToolbarButton />);
    fireEvent.click(item("Add to draft")[0]!);
    expect(recovery.insertRecentDictation).toHaveBeenCalledWith(CLEANED, "cleaned");

    const close = new Event("focus.close", { cancelable: true });
    menu.onCloseAutoFocus!(close);
    expect(close.defaultPrevented).toBe(true);
    expect(recovery.focusRecoveredComposer).toHaveBeenCalledWith("p9");

    // The next close, with nothing added, restores as usual.
    const next = new Event("focus.close", { cancelable: true });
    menu.onCloseAutoFocus!(next);
    expect(next.defaultPrevented).toBe(false);
    expect(recovery.focusRecoveredComposer).toHaveBeenCalledTimes(1);
  });

  it("forgets an add's destination when the menu reopens before its close finished", () => {
    render(<VoiceRecordingToolbarButton />);
    fireEvent.click(item("Add to draft")[0]!);
    menu.onOpenChange!(true);

    const close = new Event("focus.close", { cancelable: true });
    menu.onCloseAutoFocus!(close);
    expect(close.defaultPrevented).toBe(false);
    expect(recovery.focusRecoveredComposer).not.toHaveBeenCalled();
  });

  it("leaves focus to the menu when the add was refused", () => {
    recovery.insertRecentDictation.mockReturnValue(null);
    render(<VoiceRecordingToolbarButton />);
    fireEvent.click(item("Add to draft")[1]!);

    const close = new Event("focus.close", { cancelable: true });
    menu.onCloseAutoFocus!(close);
    expect(close.defaultPrevented).toBe(false);
    expect(recovery.focusRecoveredComposer).not.toHaveBeenCalled();
  });

  it("carries the same section on the locked button and while recording", () => {
    useVoiceRecordingStore.setState({ lockedTarget: { panelId: "p1", panelTitle: "Claude" } });
    const locked = render(<VoiceRecordingToolbarButton />);
    expect(locked.getByTestId("voice-locked-button")).toBeTruthy();
    expect(entries()).toHaveLength(2);
    locked.unmount();

    useVoiceRecordingStore.setState({
      lockedTarget: null,
      status: "recording",
      micSignal: "live",
      activeTarget: { panelId: "p1", panelTitle: "Claude" },
    });
    render(<VoiceRecordingToolbarButton />);
    expect(item("Pause dictation")).toHaveLength(1);
    expect(entries()).toHaveLength(2);
    fireEvent.click(item("Search recent dictations…")[0]!);
    expect(usePaletteStore.getState().activePaletteId).toBe("recent-dictations");
    usePaletteStore.setState({ activePaletteId: null });
  });
});

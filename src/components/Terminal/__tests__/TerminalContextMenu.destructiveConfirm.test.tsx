// @vitest-environment jsdom
/**
 * The kill confirmation the context menu owns locally must clear a dock popover
 * (#11505).
 *
 * This is the worst instance of the bug: the popover paints above the standard
 * modal tier, so "Kill terminal with running agent?" was drawn *underneath* the
 * docked terminal it was about, while still holding focus — a destructive
 * confirm the user agrees to without being able to read it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

// Render menu content synchronously — Radix only mounts it behind a real
// right-click into a portal, which tells us nothing about which items rendered.
vi.mock("@/components/ui/context-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Item = ({ children, onSelect }: { children?: React.ReactNode; onSelect?: () => void }) => (
    <button onClick={() => onSelect?.()}>{children}</button>
  );
  return {
    ContextMenu: Passthrough,
    ContextMenuTrigger: Passthrough,
    ContextMenuContent: Passthrough,
    ContextMenuItem: Item,
    ContextMenuActionItem: Item,
    ContextMenuCheckboxItem: Item,
    ContextMenuRadioGroup: Passthrough,
    ContextMenuRadioItem: Item,
    ContextMenuSeparator: () => null,
    ContextMenuLabel: Passthrough,
    ContextMenuShortcut: Passthrough,
    ContextMenuGroup: Passthrough,
    ContextMenuPortal: Passthrough,
    ContextMenuSub: Passthrough,
    ContextMenuSubContent: Passthrough,
    ContextMenuSubTrigger: Passthrough,
  };
});

const { dispatch, openDockPopoverId } = vi.hoisted(() => ({
  dispatch: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  openDockPopoverId: { current: null as string | null },
}));

// The derivation behind this is exercised against the real store shape in
// dockPanelVisibility.test.ts; here it is the input to the tier choice.
vi.mock("@/components/Layout/useOpenDockPopoverId", () => ({
  useOpenDockPopoverId: () => openDockPopoverId.current,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch, get: () => undefined, list: () => [] },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: () => ({ terminal: { getSelection: () => "" } }),
    getHoveredLinkText: () => null,
    getHoveredFilePath: () => null,
    getHoveredFileKind: () => null,
    openHoveredLink: vi.fn(),
  },
}));

vi.mock("@/services/terminal/FileLinksAddon", () => ({ reportFileLinkFailure: vi.fn() }));
vi.mock("@/hooks/useWorktrees", () => ({ useWorktrees: () => ({ worktrees: [] }) }));
vi.mock("@/hooks/useIsHibernated", () => ({ useIsHibernated: () => false }));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({ usePluginContextMenuItems: () => [] }));

vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: (selector: (s: unknown) => unknown) =>
    selector({ lockedTarget: null, recentTargets: [] }),
}));

vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: (selector: (s: { armedIds: Set<string> }) => unknown) =>
    selector({ armedIds: new Set<string>() }),
  isFleetArmEligible: () => false,
}));

const panelsById = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@/store", () => {
  const state = () => ({
    panelsById: panelsById.current,
    maximizeTarget: null,
    getPanelGroup: () => undefined,
    watchedPanels: new Set<string>(),
  });
  const usePanelStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state());
  usePanelStore.getState = state;
  // The real ConfirmDialog renders a real AppDialog, which reads the portal
  // offset from this same barrel.
  return { usePanelStore, usePortalStore: () => ({ isOpen: false, width: 0 }) };
});

class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

import { TerminalContextMenu } from "../TerminalContextMenu";
import { AppDialog } from "@/components/ui/AppDialog";

/**
 * The z-tier a surface resolved to, read off the rendered element rather than
 * compared against a hard-coded token so the tier's value stays free to change.
 */
function tierClassOf(el: Element): string | undefined {
  return Array.from(el.classList).find((c) => c.startsWith("z-["));
}

/** What each `zIndex` option actually renders, for comparison. */
function referenceTier(zIndex: "modal" | "nested"): string | undefined {
  const { unmount } = render(
    <AppDialog isOpen onClose={() => {}} zIndex={zIndex}>
      <span>reference</span>
    </AppDialog>
  );
  const tier = tierClassOf(screen.getByRole("dialog"));
  unmount();
  return tier;
}

function openKillConfirm() {
  // `terminalHasRunningAgentSession` gates the confirm: an agent terminal in a
  // state worth protecting is what routes Kill through a dialog at all.
  panelsById.current = {
    "panel-1": {
      id: "panel-1",
      title: "Agent",
      kind: "terminal",
      worktreeId: "wt-1",
      cwd: "/repo",
      launchAgentId: "claude",
      agentState: "working",
    },
  };
  const result = render(
    <TerminalContextMenu terminalId="panel-1">
      <div>Panel body</div>
    </TerminalContextMenu>
  );
  act(() => {
    result.container
      .querySelector('[data-context-trigger="panel-1"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
  act(() => {
    screen.getByText("Kill terminal").click();
  });
  return result;
}

describe("TerminalContextMenu — kill confirmation layering (#11505)", () => {
  afterEach(() => {
    cleanup();
    dispatch.mockReset();
    openDockPopoverId.current = null;
    panelsById.current = {};
  });

  it("keeps the standard tier when no dock popover is on screen", () => {
    openKillConfirm();

    expect(tierClassOf(screen.getByRole("alertdialog"))).toBe(referenceTier("modal"));
  });

  it("clears the dock popover the terminal is docked in", () => {
    openDockPopoverId.current = "panel-1";
    openKillConfirm();

    expect(tierClassOf(screen.getByRole("alertdialog"))).toBe(referenceTier("nested"));
  });

  it("distinguishes the two tiers at all", () => {
    // Guards the two assertions above: if both options ever rendered the same
    // token they would pass while the bug was fully present.
    expect(referenceTier("modal")).not.toBe(referenceTier("nested"));
  });
});

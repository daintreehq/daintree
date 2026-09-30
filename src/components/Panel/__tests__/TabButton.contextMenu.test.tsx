// @vitest-environment jsdom
/**
 * A right-click menu belongs to the object under the pointer.
 *
 * A tab strip renders inside the active panel's own `TerminalContextMenu`, so a
 * tab without a menu of its own let the right-click bubble up to that panel:
 * a background tab offered to rename, close or kill the panel in front of it.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

const { dispatch } = vi.hoisted(() => ({
  dispatch: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch, get: () => undefined, list: () => [] },
}));
vi.mock("@/hooks/useSidebarWorktreeOrder", () => ({ useSidebarWorktreeOrder: () => [] }));
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

const panelsById = vi.hoisted(() => ({
  current: {
    front: {
      id: "front",
      title: "Front",
      kind: "browser",
      location: "grid",
      browserUrl: "https://example.com",
    },
    back: {
      id: "back",
      title: "Back",
      kind: "browser",
      location: "grid",
      browserUrl: "https://example.com",
    },
  } as Record<string, unknown>,
}));

vi.mock("@/store", () => {
  const state = () => ({
    panelsById: panelsById.current,
    maximizeTarget: null,
    getPanelGroup: () => undefined,
    watchedPanels: new Set<string>(),
  });
  const usePanelStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state());
  usePanelStore.getState = state;
  return { usePanelStore };
});

import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TabButton } from "../TabButton";

function tab(id: string, isActive: boolean) {
  return (
    <TabButton
      id={id}
      title={id}
      chrome={deriveTerminalChrome({ kind: "browser" })}
      kind="browser"
      isActive={isActive}
      menuLocation="grid"
      onClick={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

/** The grid's shape: the strip sits inside the active panel's own trigger. */
function renderStrip(onAncestorContextMenu?: () => void) {
  return render(
    <TooltipProvider>
      {/* Stands in for any React handler above the panel: an enclosing Radix
          trigger listens exactly this way. */}
      <div onContextMenu={onAncestorContextMenu}>
        <TerminalContextMenu terminalId="front" forceLocation="grid">
          <div>
            <div role="tablist">
              {tab("front", true)}
              {tab("back", false)}
            </div>
            <div>Panel body</div>
          </div>
        </TerminalContextMenu>
      </div>
    </TooltipProvider>
  );
}

function tabNode(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
}

beforeAll(async () => {
  await primeRadix();
});

afterEach(() => {
  cleanup();
  dispatch.mockReset();
});

describe("TabButton — the tab under the pointer owns the menu", () => {
  it("scopes a background tab's menu to that tab's panel, not the active one", async () => {
    dispatch.mockResolvedValue({ ok: true });
    renderStrip();

    fireEvent.contextMenu(tabNode("back"));
    const menu = await screen.findByRole("menu");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename browser" }));
    });

    expect(dispatch).toHaveBeenCalledWith(
      "terminal.rename",
      { terminalId: "back" },
      expect.anything()
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      "terminal.rename",
      { terminalId: "front" },
      expect.anything()
    );
  });

  it("opens exactly one menu for a tab nested in the panel's trigger", async () => {
    renderStrip();

    fireEvent.contextMenu(tabNode("back"));
    await screen.findByRole("menu");

    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("keeps the tab's right-click from reaching anything enclosing the panel", () => {
    const reached = vi.fn();
    renderStrip(reached);

    fireEvent.contextMenu(tabNode("back"));
    expect(reached).not.toHaveBeenCalled();

    // The panel body is the panel's own surface and still bubbles as before.
    fireEvent.contextMenu(screen.getByText("Panel body"));
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it("leaves the panel's keyboard-open marker to the panel itself", () => {
    renderStrip();

    // `openPanelContextMenu` resolves the first `[data-context-trigger]` for an
    // id; a tab claiming it would steal Shift+F10 from the panel.
    expect(document.querySelectorAll('[data-context-trigger="front"]')).toHaveLength(1);
    expect(document.querySelector('[data-context-trigger="back"]')).toBeNull();
    expect(document.querySelector('[data-context-proxy="back"]')).not.toBeNull();
  });

  it("keeps a chosen item's click out of the panel and anything around it", async () => {
    dispatch.mockResolvedValue({ ok: true });
    const clicked = vi.fn();
    render(
      <TooltipProvider>
        <div onClick={clicked}>
          <TerminalContextMenu terminalId="front" forceLocation="grid">
            <div role="tablist">{tab("back", false)}</div>
          </TerminalContextMenu>
        </div>
      </TooltipProvider>
    );

    fireEvent.contextMenu(tabNode("back"));
    const menu = await screen.findByRole("menu");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename browser" }));
    });

    expect(dispatch).toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
  });
});

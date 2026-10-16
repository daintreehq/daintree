// @vitest-environment jsdom
/**
 * Outside a terminal, the panel menu belongs to the title bar (#13422): a
 * right-click in a file's text or a tree row is about what is under the
 * pointer, not about the panel. A terminal's content has no menu of its own,
 * so a terminal pane keeps the whole surface as the trigger.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import { openPanelContextMenu } from "@/lib/panelContextMenu";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(), get: () => undefined, list: () => [] },
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
    page: {
      id: "page",
      title: "Page",
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

import { TerminalContextMenu } from "../TerminalContextMenu";
import { PanelContextMenuTrigger } from "../PanelContextMenuTrigger";

function renderPanel(triggerScope?: "surface" | "header") {
  return render(
    <TerminalContextMenu terminalId="page" forceLocation="grid" triggerScope={triggerScope}>
      <div data-panel-id="page" tabIndex={-1}>
        <PanelContextMenuTrigger>
          <div>Title bar</div>
        </PanelContextMenuTrigger>
        <div>Panel body</div>
      </div>
    </TerminalContextMenu>
  );
}

function rightClick(text: string) {
  act(() => {
    fireEvent.contextMenu(screen.getByText(text), { clientX: 10, clientY: 10 });
  });
}

const menuItem = () => screen.queryByText("Reload page");

beforeAll(async () => {
  await primeRadix();
});

afterEach(() => {
  cleanup();
});

describe("TerminalContextMenu — header-scoped trigger", () => {
  it("opens from the title bar", () => {
    renderPanel("header");
    rightClick("Title bar");
    expect(menuItem()).not.toBeNull();
  });

  it("leaves a right-click in the body to the body", () => {
    renderPanel("header");
    const body = screen.getByText("Panel body");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      body.dispatchEvent(event);
    });
    expect(menuItem()).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  it("marks only the title bar as the panel's trigger", () => {
    const { container } = renderPanel("header");
    const triggers = container.querySelectorAll('[data-context-trigger="page"]');
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.textContent).toBe("Title bar");
  });

  it("still opens from the keyboard route", () => {
    renderPanel("header");
    let opened = false;
    act(() => {
      opened = openPanelContextMenu("page");
    });
    expect(opened).toBe(true);
    expect(menuItem()).not.toBeNull();
  });
});

describe("TerminalContextMenu — surface-scoped trigger", () => {
  it("opens from anywhere in the panel, the body included", () => {
    renderPanel();
    rightClick("Panel body");
    expect(menuItem()).not.toBeNull();
  });

  it("treats the header slot as plain content", () => {
    const { container } = renderPanel("surface");
    const triggers = container.querySelectorAll('[data-context-trigger="page"]');
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.textContent).toBe("Title barPanel body");
  });
});

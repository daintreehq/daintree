// @vitest-environment jsdom
/**
 * The tray's menu through the real dropdown (#16922). The menu is modal, so a
 * press on bare chrome never reaches anything that could take focus; only the
 * shared policy's fallback brings it back to the tray button, and the tray's
 * own close hook used to cancel that by claiming every pointer dismissal.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { PluginToolbarButtonId, ToolbarButtonPriority } from "@shared/types/toolbar";
import { _resetTooltipFocusSuppressionForTests } from "@/lib/tooltipFocusSuppression";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

vi.mock("@/store/toolbarPreferencesStore", () => ({
  useToolbarPreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({
      layout: { pinnedButtons: {} },
      setPluginButtonPromoted: () => {},
      toggleButtonVisibility: () => {},
    }),
}));

vi.mock("@/hooks/useResolvedPresentation", () => ({
  useProjectToolbarOverlay: () => ({ active: false, promotedPluginButtons: [] }),
}));

vi.mock("@/store/projectPresentationStore", () => ({
  useProjectPresentationStore: (selector: (s: unknown) => unknown) =>
    selector({ setPluginButtonPromoted: () => Promise.resolve(true) }),
}));

vi.mock("../saveProjectToolbar", () => ({
  saveProjectToolbar: () => {},
}));

vi.mock("@/store/pluginRuntimeStore", () => ({
  usePluginRuntimeStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ pluginMetaById: new Map() }),
    { getState: () => ({ refresh: () => {} }) }
  ),
}));

vi.mock("@/hooks", () => ({
  useAriaKeyshortcuts: () => undefined,
  useEffectiveCombo: () => "",
  useShortcutHintHover: () => ({}),
}));

// The real context menu stays: the tray's dropdown trigger sits inside its
// root, and the trigger has to register with the dropdown's policy regardless.
vi.mock("../ToolbarContextMenuItems", () => ({
  ToolbarContextMenuItems: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

const { PluginTrayButton } = await import("../PluginTrayButton");

function config(id: string): ToolbarButtonConfig {
  return {
    id: id as PluginToolbarButtonId,
    label: id,
    iconId: "sparkles",
    actionId: `${id}.action`,
    priority: 3 as ToolbarButtonPriority,
    pluginId: "acme",
  };
}

async function openTray() {
  const utils = render(<PluginTrayButton configs={new Map([["acme.a", config("acme.a")]])} />);
  const tray = utils.getByRole("button", { name: "Plugin tray" });
  fireEvent.pointerDown(tray, { button: 0, pointerType: "mouse" });
  const menu = await utils.findByRole("menu");
  return { tray, menu };
}

beforeEach(() => {
  _resetTooltipFocusSuppressionForTests();
});

afterEach(cleanup);

describe("PluginTrayButton menu close focus", () => {
  it("returns focus to the tray button, ringless, after a press on bare chrome", async () => {
    const { tray, menu } = await openTray();
    const focusTray = vi.spyOn(tray, "focus");

    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    await waitFor(() => expect(menu.isConnected).toBe(false));
    await waitFor(() => expect(focusTray).toHaveBeenCalled());

    expect(focusTray).toHaveBeenLastCalledWith(expect.objectContaining({ focusVisible: false }));
    expect(document.activeElement).toBe(tray);
  });

  it("leaves focus on a control the dismissing press focused", async () => {
    const { tray, menu } = await openTray();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const focusTray = vi.spyOn(tray, "focus");

    fireEvent.pointerDown(outside, { pointerType: "mouse" });
    outside.focus();
    await waitFor(() => expect(menu.isConnected).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(focusTray).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

// @vitest-environment jsdom
/**
 * The `…` menu through the real dropdown (#16922). The menu is modal, so a
 * press on bare chrome never reaches anything that could take focus; only the
 * shared policy's fallback brings it back to the `…` button, and the menu's
 * own close hook used to cancel that by claiming every pointer dismissal.
 */
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetTooltipFocusSuppressionForTests } from "@/lib/tooltipFocusSuppression";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// The launcher's own rows need its stores; the menu's handoff is what is under
// test here, so one row stands in that asks for the launcher the way the dev
// servers row does.
vi.mock("../LinksLauncher", async () => {
  const { DropdownMenuItem } = await import("@/components/ui/dropdown-menu");
  const { useLinksLauncherStore } = await import("@/store/linksLauncherStore");
  return {
    LinksLauncherOverflowItems: ({ side }: { side: "left" | "right" }) => (
      <DropdownMenuItem onSelect={() => useLinksLauncherStore.getState().deferFromOverflow(side)}>
        Dev servers…
      </DropdownMenuItem>
    ),
  };
});

const { OverflowMenu } = await import("../ToolbarOverflowMenu");
const { useLinksLauncherStore } = await import("@/store/linksLauncherStore");

async function openOverflow(overflowIds: string[] = []) {
  const utils = render(
    <OverflowMenu
      overflowIds={overflowIds as Parameters<typeof OverflowMenu>[0]["overflowIds"]}
      side="right"
      severity={null}
      errorCount={0}
      notificationUnreadCount={0}
      canopyUrgentCount={0}
      agentObservations={[]}
      agentAttentionStates={new Map()}
      canCopyTree={false}
      forgeStatsRef={{ current: null }}
      forgeProviderName={null}
      overflowActions={{}}
      dynamicOverflowMeta={{}}
      pluginTrayGroups={[]}
      pluginConfigs={new Map()}
      launcherAgentIds={[]}
      launcherPanelItems={[]}
      panelTrayDisabled={{}}
      keybindingById={{}}
      branchRow={{ label: "main", copyLabel: "Branch name", copyValue: "main" }}
      resolveGroup={() => "launcher"}
      unavailableReasonById={{}}
    />
  );
  const trigger = utils.container.querySelector<HTMLButtonElement>(
    "[data-toolbar-overflow-trigger]"
  )!;
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  const menu = await utils.findByRole("menu");
  return { trigger, menu };
}

beforeEach(() => {
  _resetTooltipFocusSuppressionForTests();
  useLinksLauncherStore.setState({
    opening: null,
    closeFocus: null,
    detachedRestore: null,
    deferredFromOverflow: null,
  });
});

afterEach(cleanup);

describe("toolbar overflow menu close focus", () => {
  it("returns focus to the … button, ringless, after a press on bare chrome", async () => {
    const { trigger, menu } = await openOverflow();
    const focusTrigger = vi.spyOn(trigger, "focus");

    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    await waitFor(() => expect(menu.isConnected).toBe(false));
    await waitFor(() => expect(focusTrigger).toHaveBeenCalled());

    expect(focusTrigger).toHaveBeenLastCalledWith(expect.objectContaining({ focusVisible: false }));
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves focus on a control the dismissing press focused", async () => {
    const { trigger, menu } = await openOverflow();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const focusTrigger = vi.spyOn(trigger, "focus");

    fireEvent.pointerDown(outside, { pointerType: "mouse" });
    outside.focus();
    await waitFor(() => expect(menu.isConnected).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(focusTrigger).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("opens the links launcher once the menu has closed, keeping focus off the … button until it closes", async () => {
    const { trigger, menu } = await openOverflow(["links-launcher"]);
    const focusTrigger = vi.spyOn(trigger, "focus");

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Dev servers…" }));
    await waitFor(() => expect(menu.isConnected).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(useLinksLauncherStore.getState().opening?.origin).toBe("detached");
    expect(useLinksLauncherStore.getState().deferredFromOverflow).toBeNull();
    expect(focusTrigger).not.toHaveBeenCalled();

    // The launcher's close gives focus back to the … button it came from.
    useLinksLauncherStore.getState().takeDetachedRestore()?.();
    expect(document.activeElement).toBe(trigger);
  });

  it("drops a request a closed menu never spent when it opens again", async () => {
    useLinksLauncherStore.getState().deferFromOverflow("right");
    const { menu } = await openOverflow(["links-launcher"]);
    expect(useLinksLauncherStore.getState().deferredFromOverflow).toBeNull();

    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    await waitFor(() => expect(menu.isConnected).toBe(false));

    expect(useLinksLauncherStore.getState().opening).toBeNull();
  });
});

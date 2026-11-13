// @vitest-environment jsdom
/**
 * The `…` menu through the real dropdown (#16922). The menu is modal, so a
 * press on bare chrome never reaches anything that could take focus; only the
 * shared policy's fallback brings it back to the `…` button, and the menu's
 * own close hook used to cancel that by claiming every pointer dismissal.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetTooltipFocusSuppressionForTests } from "@/lib/tooltipFocusSuppression";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

const { OverflowMenu } = await import("../ToolbarOverflowMenu");

async function openOverflow() {
  const utils = render(
    <OverflowMenu
      overflowIds={[]}
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
});

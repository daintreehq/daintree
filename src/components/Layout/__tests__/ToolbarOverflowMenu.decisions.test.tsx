// @vitest-environment jsdom
/**
 * The Decisions inbox button folded into `…` (#17236) keeps what it says on
 * the strip: the questions waiting on the person and the deliveries stopped
 * (#18045), in the trigger's name and on its row, standing down while the
 * inbox is open, and its row opens the inbox.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock("../LinksLauncher", () => ({ LinksLauncherOverflowItems: () => null }));

const { OverflowMenu } = await import("../ToolbarOverflowMenu");
const { useDecisionsInboxStore } = await import("@/store/decisionsInboxStore");

function renderMenu(decisionsWaitingCount: number, openInbox = vi.fn(), decisionsStoppedCount = 0) {
  const utils = render(
    <OverflowMenu
      overflowIds={["decisions-inbox"]}
      side="right"
      severity={
        decisionsWaitingCount > 0 ? "waiting" : decisionsStoppedCount > 0 ? "warning" : null
      }
      errorCount={0}
      notificationUnreadCount={0}
      canopyUrgentCount={0}
      decisionsWaitingCount={decisionsWaitingCount}
      decisionsStoppedCount={decisionsStoppedCount}
      agentObservations={[]}
      agentAttentionStates={new Map()}
      canCopyTree={false}
      forgeStatsRef={{ current: null }}
      forgeProviderName={null}
      overflowActions={{ "decisions-inbox": openInbox }}
      dynamicOverflowMeta={{}}
      pluginTrayGroups={[]}
      pluginConfigs={new Map()}
      launcherAgentIds={[]}
      launcherPanelItems={[]}
      panelTrayDisabled={{}}
      keybindingById={{}}
      branchRow={null}
      resolveGroup={() => "signals"}
      unavailableReasonById={{}}
    />
  );
  const trigger = utils.container.querySelector<HTMLButtonElement>(
    "[data-toolbar-overflow-trigger]"
  )!;
  return { ...utils, trigger, openInbox };
}

async function openMenu(utils: ReturnType<typeof renderMenu>) {
  fireEvent.pointerDown(utils.trigger, { button: 0, pointerType: "mouse" });
  return utils.findByRole("menu");
}

afterEach(() => {
  cleanup();
  useDecisionsInboxStore.setState({ isOpen: false });
});

describe("the Decisions inbox button in the overflow menu", () => {
  it("says how many questions wait on the person, on the trigger and on its row", async () => {
    const utils = renderMenu(2);
    expect(utils.trigger.getAttribute("aria-label")).toBe(
      "More toolbar items — 1 hidden, 2 questions waiting"
    );
    const menu = await openMenu(utils);
    const row = within(menu).getByRole("menuitem", {
      name: /^Decisions inbox\s*— 2 questions waiting$/,
    });
    // The count trails the row, as the visible button's badge carries it.
    expect(row.lastElementChild?.textContent).toBe("2");
  });

  it("says nothing more with no question waiting", async () => {
    const utils = renderMenu(0);
    expect(utils.trigger.getAttribute("aria-label")).toBe("More toolbar items — 1 hidden");
    const menu = await openMenu(utils);
    const row = within(menu).getByRole("menuitem", { name: /^Decisions inbox/ });
    expect(row.textContent).toBe("Decisions inbox");
  });

  it("stands down while the inbox is open, which shows them itself", async () => {
    useDecisionsInboxStore.setState({ isOpen: true });
    const utils = renderMenu(2);
    expect(utils.trigger.getAttribute("aria-label")).toBe("More toolbar items — 1 hidden");
    const menu = await openMenu(utils);
    const row = within(menu).getByRole("menuitem", { name: /^Decisions inbox/ });
    expect(row.textContent).toBe("Decisions inbox");
  });

  it("warns of a stopped delivery with no count of its own (#18045)", async () => {
    const utils = renderMenu(0, vi.fn(), 1);
    expect(utils.trigger.getAttribute("aria-label")).toBe(
      "More toolbar items — 1 hidden, 1 delivery stopped"
    );
    const menu = await openMenu(utils);
    const row = within(menu).getByRole("menuitem", {
      name: /^Decisions inbox\s*— 1 delivery stopped$/,
    });
    const pips = row.querySelectorAll(".toolbar-menu-pip");
    expect([...pips].map((pip) => pip.getAttribute("data-badge-color"))).toEqual(["warning"]);
    // A warning, not another number: nothing trails the label.
    expect(row.textContent).toBe("Decisions inbox — 1 delivery stopped");
  });

  it("marks both on the row's glyph when questions wait and a delivery stopped", async () => {
    const utils = renderMenu(2, vi.fn(), 3);
    expect(utils.trigger.getAttribute("aria-label")).toBe(
      "More toolbar items — 1 hidden, 2 questions waiting, 3 deliveries stopped"
    );
    const menu = await openMenu(utils);
    const row = within(menu).getByRole("menuitem", {
      name: /^Decisions inbox\s*— 2 questions waiting, 3 deliveries stopped$/,
    });
    const pips = [...row.querySelectorAll(".toolbar-menu-pip")];
    expect(pips.map((pip) => pip.getAttribute("data-pip"))).toEqual(["waiting", null]);
    expect(pips[1]!.getAttribute("data-badge-color")).toBe("warning");
    // The count is the questions' alone.
    expect(row.lastElementChild?.textContent).toBe("2");
  });

  it("stands the warning down while the inbox is open", async () => {
    useDecisionsInboxStore.setState({ isOpen: true });
    const utils = renderMenu(0, vi.fn(), 1);
    expect(utils.trigger.getAttribute("aria-label")).toBe("More toolbar items — 1 hidden");
    const menu = await openMenu(utils);
    const row = within(menu).getByRole("menuitem", { name: /^Decisions inbox/ });
    expect(row.querySelector(".toolbar-menu-pip")).toBeNull();
  });

  it("opens the inbox from its row", async () => {
    const utils = renderMenu(2);
    const menu = await openMenu(utils);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Decisions inbox/ }));
    expect(utils.openInbox).toHaveBeenCalledTimes(1);
  });
});

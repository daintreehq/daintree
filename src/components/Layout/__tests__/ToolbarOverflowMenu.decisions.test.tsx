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
type OverflowBadgeSeverity = import("../useOverflowBadgeSeverity").OverflowBadgeSeverity;
const { useDecisionsInboxStore } = await import("@/store/decisionsInboxStore");

function renderMenu(
  decisionsWaitingCount: number,
  openInbox = vi.fn(),
  decisionsStoppedCount = 0,
  severity: OverflowBadgeSeverity = decisionsWaitingCount > 0
    ? "waiting"
    : decisionsStoppedCount > 0
      ? "warning"
      : null
) {
  const utils = render(
    <OverflowMenu
      overflowIds={["decisions-inbox"]}
      side="right"
      severity={severity}
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

/** The trigger's second pip: the stopped deliveries' warning, when a louder mark takes the corner. */
function warningOnTrigger(utils: ReturnType<typeof renderMenu>) {
  return utils.trigger
    .querySelector('[data-testid="toolbar-overflow-decisions-warning"]')!
    .getAttribute("data-visible");
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
    // The waiting ring alone, no warning beside it.
    const pips = [...row.querySelectorAll(".toolbar-menu-pip")];
    expect(pips.map((pip) => pip.getAttribute("data-pip"))).toEqual(["waiting"]);
    expect(warningOnTrigger(utils)).toBe("false");
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

  it("names plural stopped deliveries alone", async () => {
    const utils = renderMenu(0, vi.fn(), 2);
    expect(utils.trigger.getAttribute("aria-label")).toBe(
      "More toolbar items — 1 hidden, 2 deliveries stopped"
    );
    // The trigger's own mark is the warning, so it needs no second one.
    expect(warningOnTrigger(utils)).toBe("false");
    const menu = await openMenu(utils);
    const row = within(menu).getByRole("menuitem", {
      name: /^Decisions inbox\s*— 2 deliveries stopped$/,
    });
    expect(row.querySelectorAll(".toolbar-menu-pip").length).toBe(1);
    expect(row.textContent).toBe("Decisions inbox — 2 deliveries stopped");
  });

  it("keeps the warning on the trigger when a louder folded mark takes its corner", () => {
    expect(warningOnTrigger(renderMenu(2, vi.fn(), 1))).toBe("true");
    cleanup();
    expect(warningOnTrigger(renderMenu(0, vi.fn(), 1, "critical"))).toBe("true");
    cleanup();
    expect(warningOnTrigger(renderMenu(0, vi.fn(), 0, "critical"))).toBe("false");
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
    // Opposite corners of the glyph: the ring on top, the warning below.
    expect(pips[0]!.className).toContain("-top-0.5");
    expect(pips[1]!.className).toContain("-bottom-0.5");
    // The count is the questions' alone.
    expect(row.lastElementChild?.textContent).toBe("2");
  });

  it("stands the warning down while the inbox is open, with questions waiting too", async () => {
    useDecisionsInboxStore.setState({ isOpen: true });
    const utils = renderMenu(2, vi.fn(), 1, "critical");
    expect(utils.trigger.getAttribute("aria-label")).toBe("More toolbar items — 1 hidden");
    expect(warningOnTrigger(utils)).toBe("false");
    const menu = await openMenu(utils);
    const row = within(menu).getByRole("menuitem", { name: /^Decisions inbox/ });
    expect(row.querySelector(".toolbar-menu-pip")).toBeNull();
    expect(row.textContent).toBe("Decisions inbox");
  });

  it("opens the inbox from its row", async () => {
    const utils = renderMenu(2);
    const menu = await openMenu(utils);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Decisions inbox/ }));
    expect(utils.openInbox).toHaveBeenCalledTimes(1);
  });
});

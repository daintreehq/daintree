import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as unknown as { window?: unknown }).window = {
    ...((globalThis as unknown as { window?: unknown }).window as Record<string, unknown>),
    electron: { portal: { hide: vi.fn(() => Promise.resolve()) } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    top: globalThis,
  } as unknown;
});

import type { PortalTab } from "@shared/types";
import { usePortalStore } from "@/store/portalStore";
import { usePortalPendingCloseStore } from "@/store/portalPendingCloseStore";

async function createRegistry() {
  (globalThis as any).self = globalThis;
  const { createActionDefinitions } = await import("../actionDefinitions");
  return createActionDefinitions({
    onOpenSettings: () => {},
    onOpenSettingsTab: () => {},
    onToggleSidebar: () => {},
    onToggleFocusMode: () => {},
    onFocusRegionNext: () => {},
    onFocusRegionPrev: () => {},
    onOpenActionPalette: () => {},
    onOpenQuickSwitcher: () => {},
    onOpenWorktreePalette: () => {},
    onOpenQuickCreatePalette: () => {},
    onToggleWorktreeOverview: () => {},
    onOpenWorktreeOverview: () => {},
    onCloseWorktreeOverview: () => {},
    onOpenPanelPalette: () => {},
    onOpenProjectSwitcherPalette: () => {},
    onConfirmCloseActiveProject: () => {},
    onOpenShortcuts: () => {},
    onLaunchAgent: async () => null,
    onInject: () => {},
    onAddTerminal: async () => {},
    getDefaultCwd: () => "/",
    getActiveWorktreeId: () => undefined,
    getWorktrees: () => [],
    getFocusedId: () => null,
    getIsSettingsOpen: () => false,
    getGridNavigation: () => ({
      findNearest: () => null,
      findByIndex: () => null,
      findDockByIndex: () => null,
      getCurrentLocation: () => null,
    }),
  });
}

const tab = (id: string): PortalTab => ({ id, url: `https://x/${id}`, title: id });

function seedTabs(ids: string[]) {
  usePortalStore.setState({
    tabs: ids.map(tab),
    activeTabId: ids[0] ?? null,
    createdTabs: new Set<string>(),
  });
}

async function run(
  actions: Awaited<ReturnType<typeof createRegistry>>,
  id: string,
  args?: unknown
) {
  const def = actions.get(id)!();
  await def.run!(args as never, {});
  return def;
}

beforeEach(() => {
  usePortalPendingCloseStore.getState().clear();
});

describe("portal.closeAllTabs runtime escalation", () => {
  it("closes immediately with 2 tabs (D0) — no pending request", async () => {
    const actions = await createRegistry();
    seedTabs(["a", "b"]);
    await run(actions, "portal.closeAllTabs");
    expect(usePortalStore.getState().tabs).toHaveLength(0);
    expect(usePortalPendingCloseStore.getState().pending).toBeNull();
  });

  it("escalates with 3 tabs (D1) — requests confirm, leaves tabs intact", async () => {
    const actions = await createRegistry();
    seedTabs(["a", "b", "c"]);
    await run(actions, "portal.closeAllTabs");
    expect(usePortalStore.getState().tabs).toHaveLength(3);
    const pending = usePortalPendingCloseStore.getState().pending;
    expect(pending?.kind).toBe("closeAll");
    expect(pending?.tabsToClose).toHaveLength(3);
  });

  it("confirmed:true bypasses the gate and closes", async () => {
    const actions = await createRegistry();
    seedTabs(["a", "b", "c"]);
    await run(actions, "portal.closeAllTabs", { confirmed: true });
    expect(usePortalStore.getState().tabs).toHaveLength(0);
    expect(usePortalPendingCloseStore.getState().pending).toBeNull();
  });

  it("is marked nonRepeatable so repeatLast cannot replay a confirmed close", async () => {
    const actions = await createRegistry();
    expect(actions.get("portal.closeAllTabs")!().nonRepeatable).toBe(true);
    expect(actions.get("portal.closeOthers")!().nonRepeatable).toBe(true);
  });
});

describe("portal.closeOthers runtime escalation", () => {
  it("escalates on tabs-that-would-close, not total (4 tabs → 3 close → D1)", async () => {
    const actions = await createRegistry();
    seedTabs(["keep", "a", "b", "c"]);
    await run(actions, "portal.closeOthers", { tabId: "keep" });
    expect(usePortalStore.getState().tabs).toHaveLength(4);
    const pending = usePortalPendingCloseStore.getState().pending;
    expect(pending?.kind).toBe("closeOthers");
    expect(pending?.keepTabId).toBe("keep");
    expect(pending?.tabsToClose.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("does not escalate when only 2 tabs would close (3 total → D0)", async () => {
    const actions = await createRegistry();
    seedTabs(["keep", "a", "b"]);
    await run(actions, "portal.closeOthers", { tabId: "keep" });
    expect(usePortalStore.getState().tabs.map((t) => t.id)).toEqual(["keep"]);
    expect(usePortalPendingCloseStore.getState().pending).toBeNull();
  });
});

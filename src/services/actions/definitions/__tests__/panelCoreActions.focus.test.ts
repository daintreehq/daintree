// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const focusPanelInput = vi.hoisted(() => vi.fn(() => true));

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/diagnosticsStore", () => ({ useDiagnosticsStore: { getState: vi.fn() } }));
vi.mock("@/store/errorStore", () => ({ useErrorStore: { getState: vi.fn() } }));
vi.mock("@/store/portalStore", () => ({ usePortalStore: { getState: vi.fn() } }));
vi.mock("@/components/Panel/panelFocusRegistry", () => ({ focusPanelInput }));

import { registerPanelCoreActions } from "../panelCoreActions";

const activateTerminal = vi.fn();

function focus(panelId: string) {
  const actions: ActionRegistry = new Map();
  registerPanelCoreActions(actions, {} as unknown as ActionCallbacks);
  const factory = actions.get("panel.focus");
  if (!factory) throw new Error("panel.focus not registered");
  return (factory() as AnyActionDefinition).run({ panelId }, {} as never);
}

/** `focusedId` is the SELECTION pointer; DOM focus is tracked separately. */
function seedPanels(focusedId: string | null) {
  panelStoreMock.getState.mockReturnValue({
    panelsById: {
      "panel-a": { id: "panel-a", location: "grid" },
      "panel-gone": { id: "panel-gone", location: "trash" },
    },
    focusedId,
    activateTerminal,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  focusPanelInput.mockReturnValue(true);
  seedPanels(null);
});

describe("panel.focus", () => {
  it("selects the panel and hands it DOM focus", async () => {
    await focus("panel-a");

    expect(activateTerminal).toHaveBeenCalledWith("panel-a");
    expect(focusPanelInput).toHaveBeenCalledWith("panel-a");
  });

  it("still re-focuses a panel that is already the selected one", async () => {
    // The regression: selection and focus are separate states. Clicking a run
    // that is already selected but whose keyboard focus has drifted elsewhere
    // (the worktree list, the sidebar) leaves `activateTerminal` with nothing
    // to change, so the pane's focus effect never re-runs and the click does
    // visibly nothing.
    seedPanels("panel-a");

    await focus("panel-a");

    expect(focusPanelInput).toHaveBeenCalledWith("panel-a");
  });

  it("rejects a panel that no longer exists rather than focusing nothing", async () => {
    await expect(focus("panel-missing")).rejects.toThrow();
    expect(focusPanelInput).not.toHaveBeenCalled();
  });

  it("rejects a trashed panel", async () => {
    await expect(focus("panel-gone")).rejects.toThrow();
    expect(activateTerminal).not.toHaveBeenCalled();
    expect(focusPanelInput).not.toHaveBeenCalled();
  });

  it("does not fail when the pane cannot take focus yet", async () => {
    // A pane that is not mounted reports false. That path is covered by its
    // own mount-time effect, so the action must not treat it as an error.
    focusPanelInput.mockReturnValue(false);

    await expect(focus("panel-a")).resolves.not.toThrow();
    expect(activateTerminal).toHaveBeenCalledWith("panel-a");
  });
});

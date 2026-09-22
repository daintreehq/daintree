import { describe, it, expect, vi } from "vitest";
import {
  dispatchToolbarVisibility,
  isToolbarButtonOnToolbar,
  setToolbarButtonOnToolbar,
  type ToolbarButtonPlacementActions,
  type ToolbarButtonPlacementState,
  type ToolbarVisibilityDispatchDeps,
} from "@/lib/toolbarVisibilityDispatch";
import { isToolbarButtonVisible } from "@/components/Layout/toolbarButtonMetadata";
import { launcherItemToolbarButtonId } from "@shared/types/toolbar";
import type { AnyToolbarButtonId, ToolbarPinnedState } from "@/../../shared/types/toolbar";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type { AgentAvailabilityState } from "@shared/types/ipc/system";

function makeDeps(
  overrides: Partial<ToolbarVisibilityDispatchDeps> = {}
): ToolbarVisibilityDispatchDeps {
  return {
    agentSettings: null,
    agentAvailability: null,
    setAgentPinned: vi.fn(),
    toggleButtonVisibility: vi.fn(),
    ...overrides,
  };
}

describe("dispatchToolbarVisibility", () => {
  it.each(["ready", "installed", "blocked", "unauthenticated"] as const)(
    "undefined-pinned agent + %s availability flips to false (hide — already visible)",
    (state) => {
      const deps = makeDeps({
        agentSettings: { agents: {} } as AgentSettings,
        agentAvailability: { claude: state } as unknown as CliAvailability,
      });
      dispatchToolbarVisibility("claude", "left", deps);
      expect(deps.setAgentPinned).toHaveBeenCalledWith("claude", false);
      expect(deps.toggleButtonVisibility).not.toHaveBeenCalled();
    }
  );

  it("undefined-pinned agent + missing availability flips to true (show)", () => {
    const deps = makeDeps({
      agentSettings: { agents: {} } as AgentSettings,
      agentAvailability: { claude: "missing" } as unknown as CliAvailability,
    });
    dispatchToolbarVisibility("claude", "left", deps);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("claude", true);
  });

  it("explicitly pinned (true) agent flips to false regardless of availability", () => {
    const deps = makeDeps({
      agentSettings: { agents: { claude: { pinned: true } } } as AgentSettings,
      agentAvailability: { claude: "missing" } as unknown as CliAvailability,
    });
    dispatchToolbarVisibility("claude", "left", deps);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("claude", false);
  });

  it("explicitly unpinned (false) agent flips to true regardless of availability", () => {
    const deps = makeDeps({
      agentSettings: { agents: { claude: { pinned: false } } } as AgentSettings,
      agentAvailability: { claude: "ready" } as unknown as CliAvailability,
    });
    dispatchToolbarVisibility("claude", "left", deps);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("claude", true);
  });

  it("explicitPinned=false bypasses availability lookup", () => {
    const deps = makeDeps({
      agentSettings: null,
      agentAvailability: null,
    });
    dispatchToolbarVisibility("claude", "left", deps, false);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("claude", false);
  });

  it("explicitPinned=true bypasses availability lookup", () => {
    const deps = makeDeps({
      agentSettings: null,
      agentAvailability: null,
    });
    dispatchToolbarVisibility("claude", "left", deps, true);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("claude", true);
  });

  it("non-agent button routes through toggleButtonVisibility on the requested side", () => {
    const deps = makeDeps();
    dispatchToolbarVisibility("terminal", "right", deps);
    expect(deps.toggleButtonVisibility).toHaveBeenCalledWith("terminal", "right");
    expect(deps.setAgentPinned).not.toHaveBeenCalled();
  });

  it("non-agent button respects left vs right", () => {
    const deps = makeDeps();
    dispatchToolbarVisibility("browser", "left", deps);
    expect(deps.toggleButtonVisibility).toHaveBeenCalledWith("browser", "left");
  });

  it("launcher is not an agent ID — routes through toggleButtonVisibility", () => {
    const deps = makeDeps();
    dispatchToolbarVisibility("launcher", "left", deps);
    expect(deps.toggleButtonVisibility).toHaveBeenCalledWith("launcher", "left");
    expect(deps.setAgentPinned).not.toHaveBeenCalled();
  });

  it("plugin button routes through toggleButtonVisibility", () => {
    const deps = makeDeps();
    dispatchToolbarVisibility("plugin.foo.bar", "right", deps);
    expect(deps.toggleButtonVisibility).toHaveBeenCalledWith("plugin.foo.bar", "right");
    expect(deps.setAgentPinned).not.toHaveBeenCalled();
  });

  it("null agentSettings treated as no entry — flips on availability alone", () => {
    const deps = makeDeps({
      agentSettings: null,
      agentAvailability: { gemini: "ready" } as unknown as CliAvailability,
    });
    dispatchToolbarVisibility("gemini", "left", deps);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("gemini", false);
  });

  it("null agentAvailability treated as missing — flips undefined-pinned agent to true", () => {
    const deps = makeDeps({
      agentSettings: { agents: {} } as AgentSettings,
      agentAvailability: null,
    });
    dispatchToolbarVisibility("gemini", "left", deps);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("gemini", true);
  });
});

const PLUGIN_ID: AnyToolbarButtonId = "acme.deploy";
// A plugin-contributed recipe carries a dot of its own (#12217).
const DOTTED_RECIPE_ID = launcherItemToolbarButtonId("recipe", "publisher.name");

function makeState(
  overrides: Partial<ToolbarButtonPlacementState> = {}
): ToolbarButtonPlacementState {
  return {
    pinnedButtons: {},
    leftButtons: [],
    rightButtons: [],
    agentSettings: null,
    agentAvailability: null,
    isPluginContribution: (id) => id === PLUGIN_ID,
    ...overrides,
  };
}

function makeActions(): ToolbarButtonPlacementActions {
  return {
    setAgentPinned: vi.fn<ToolbarButtonPlacementActions["setAgentPinned"]>(),
    toggleButtonVisibility: vi.fn<ToolbarButtonPlacementActions["toggleButtonVisibility"]>(),
    positionAgentButton: vi.fn<ToolbarButtonPlacementActions["positionAgentButton"]>(),
    setPluginButtonPromoted: vi.fn<ToolbarButtonPlacementActions["setPluginButtonPromoted"]>(),
    setPanelButtonOnToolbar: vi.fn<ToolbarButtonPlacementActions["setPanelButtonOnToolbar"]>(),
    setLauncherItemOnToolbar: vi.fn<ToolbarButtonPlacementActions["setLauncherItemOnToolbar"]>(),
  };
}

describe("isToolbarButtonOnToolbar", () => {
  const PARITY_IDS: AnyToolbarButtonId[] = [
    "terminal",
    "browser",
    "forge-stats",
    "launcher",
    "claude",
    PLUGIN_ID,
    launcherItemToolbarButtonId("recipe", "build"),
  ];
  const PARITY_CASES = PARITY_IDS.flatMap((id) =>
    [undefined, true, false].flatMap((pin) =>
      (["ready", "missing"] satisfies AgentAvailabilityState[]).map(
        (availability) => [id, pin, availability] as const
      )
    )
  );

  // The toolbar renders from `isToolbarButtonVisible`; its menu draws checkmarks
  // from this. For a button that holds a slot the two must never disagree, or
  // the menu would describe a toolbar other than the one on screen.
  it.each(PARITY_CASES)(
    "agrees with the toolbar's own filter for positioned %s (pin %s, CLI %s)",
    (id, pin, availability) => {
      const pinnedButtons: ToolbarPinnedState = {};
      const agentSettings: AgentSettings = { agents: {} };
      if (pin !== undefined) {
        pinnedButtons[id] = pin;
        agentSettings.agents[id] = { pinned: pin };
      }
      const agentAvailability: CliAvailability = { claude: availability };
      const state = makeState({
        pinnedButtons,
        leftButtons: [id],
        agentSettings,
        agentAvailability,
      });

      expect(isToolbarButtonOnToolbar(id, state)).toBe(
        isToolbarButtonVisible(
          id,
          pinnedButtons,
          agentSettings,
          agentAvailability,
          state.isPluginContribution(id)
        )
      );
    }
  );

  it("reads an unpositioned panel button as off unless the user promoted it", () => {
    expect(isToolbarButtonOnToolbar("browser", makeState())).toBe(false);
    expect(
      isToolbarButtonOnToolbar("browser", makeState({ pinnedButtons: { browser: true } }))
    ).toBe(true);
  });

  it("reads an installed agent with no position as off", () => {
    const state = makeState({ agentAvailability: { claude: "ready" } });

    expect(isToolbarButtonOnToolbar("claude", state)).toBe(false);
  });

  it("gives a registered contribution the tray default and an unclaimed dotted id the built-in one", () => {
    expect(isToolbarButtonOnToolbar(PLUGIN_ID, makeState())).toBe(false);
    expect(
      isToolbarButtonOnToolbar(PLUGIN_ID, makeState({ isPluginContribution: () => false }))
    ).toBe(true);
  });
});

describe("setToolbarButtonOnToolbar", () => {
  it("does nothing when the button already reads as requested", () => {
    const actions = makeActions();

    setToolbarButtonOnToolbar(
      "forge-stats",
      "right",
      true,
      makeState({ rightButtons: ["forge-stats"] }),
      actions
    );
    setToolbarButtonOnToolbar(
      "forge-stats",
      "right",
      false,
      makeState({ rightButtons: ["forge-stats"], pinnedButtons: { "forge-stats": false } }),
      actions
    );

    for (const action of Object.values(actions)) {
      expect(action).not.toHaveBeenCalled();
    }
  });

  it("brings a hidden built-in back through the generic toggle on its own side", () => {
    const actions = makeActions();

    setToolbarButtonOnToolbar(
      "forge-stats",
      "right",
      true,
      makeState({ rightButtons: ["forge-stats"], pinnedButtons: { "forge-stats": false } }),
      actions
    );

    expect(actions.toggleButtonVisibility).toHaveBeenCalledExactlyOnceWith("forge-stats", "right");
  });

  it("promotes a registered contribution instead of toggling it", () => {
    const actions = makeActions();

    setToolbarButtonOnToolbar(
      PLUGIN_ID,
      "right",
      true,
      makeState({ rightButtons: [PLUGIN_ID] }),
      actions
    );

    expect(actions.setPluginButtonPromoted).toHaveBeenCalledExactlyOnceWith(PLUGIN_ID, true);
    expect(actions.toggleButtonVisibility).not.toHaveBeenCalled();
  });

  it("sends a dotted launcher item to its own setter, not the plugin one", () => {
    const actions = makeActions();

    setToolbarButtonOnToolbar(
      DOTTED_RECIPE_ID,
      "left",
      true,
      makeState({ isPluginContribution: () => false }),
      actions
    );

    expect(actions.setLauncherItemOnToolbar).toHaveBeenCalledExactlyOnceWith(
      DOTTED_RECIPE_ID,
      true
    );
    expect(actions.setPluginButtonPromoted).not.toHaveBeenCalled();
  });

  it("shows a panel button through the panel setter, never the generic toggle", () => {
    const actions = makeActions();

    setToolbarButtonOnToolbar("browser", "left", true, makeState(), actions);

    expect(actions.setPanelButtonOnToolbar).toHaveBeenCalledExactlyOnceWith("browser", true);
    expect(actions.toggleButtonVisibility).not.toHaveBeenCalled();
  });

  it("pins an installed but unpositioned agent and asks for a position", () => {
    const actions = makeActions();

    setToolbarButtonOnToolbar(
      "claude",
      "left",
      true,
      makeState({ agentAvailability: { claude: "ready" } }),
      actions
    );

    expect(actions.setAgentPinned).toHaveBeenCalledExactlyOnceWith("claude", true);
    expect(actions.positionAgentButton).toHaveBeenCalledExactlyOnceWith("claude");
  });

  it("unpins a shown agent and leaves its position alone", () => {
    const actions = makeActions();

    setToolbarButtonOnToolbar(
      "claude",
      "left",
      false,
      makeState({
        leftButtons: ["claude"],
        agentSettings: { agents: { claude: { pinned: true } } },
      }),
      actions
    );

    expect(actions.setAgentPinned).toHaveBeenCalledExactlyOnceWith("claude", false);
    expect(actions.positionAgentButton).not.toHaveBeenCalled();
  });
});

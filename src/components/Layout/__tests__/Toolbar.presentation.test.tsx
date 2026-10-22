// @vitest-environment jsdom
/**
 * The forge stats pill as the presentation profile's first consumer (#13771):
 * demoted folds it into the `…` menu while it stays mounted for that menu's
 * rows, hidden drops its slot. Mounts the real Toolbar.
 */
import "../__preview__/toolbarShims";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { CliAvailability, AgentSettings } from "@shared/types";
import type { PresentationLevels } from "@shared/config/presentationProfile";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import {
  _resetProjectPresentationStoreForTest,
  useProjectPresentationStore,
} from "@/store/projectPresentationStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { PREVIEW_PROJECT } from "../__preview__/toolbarShims";
import { Toolbar } from "../Toolbar";
import { useProjectSwitcherPalette } from "@/hooks/useProjectSwitcherPalette";

const noop = () => {};

function Harness() {
  const projectSwitcherPalette = useProjectSwitcherPalette();
  return (
    <Toolbar
      onLaunchAgent={noop}
      onSettings={noop}
      hasWorkspace
      agentAvailability={{} as CliAvailability}
      agentSettings={{ agents: {} } as AgentSettings}
      projectSwitcherPalette={projectSwitcherPalette}
    />
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function applyProfile(
  levels: PresentationLevels,
  useProjectToolbar: boolean | null = null
): Promise<void> {
  act(() => {
    useProjectPresentationStore.setState({
      loaded: true,
      projectId: PREVIEW_PROJECT.id,
      levels,
      useProjectToolbar,
    });
  });
  await settle();
}

const forgeSlot = () => document.querySelector('[data-toolbar-button-id="forge-stats"]');
// The pill sits in the right-hand row by default, so its `…` menu is that side's.
const forgeMenuShown = () =>
  document
    .querySelector('[data-toolbar-overflow-trigger][data-toolbar-overflow-side="right"]')
    ?.getAttribute("data-visible") === "true";

beforeEach(async () => {
  // Room for every button, so only the profile can put one in the `…` menu.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 5000,
    height: 40,
    top: 0,
    left: 0,
    right: 5000,
    bottom: 40,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  _resetProjectPresentationStoreForTest();
  initBuiltInPanelKinds();
  const worktreeStore = createWorktreeStore();
  setCurrentViewStore(worktreeStore);
  useWorktreeSelectionStore.setState({ activeWorktreeId: null });
  useProjectStore.setState({ currentProject: PREVIEW_PROJECT });

  render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <Harness />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await settle();
});

const initialToolbarLayout = useToolbarPreferencesStore.getState().layout;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  _resetProjectPresentationStoreForTest();
  useToolbarPreferencesStore.setState({ layout: initialToolbarLayout });
});

describe("Toolbar forge stats under the presentation profile", () => {
  it("draws the pill on the row by default", () => {
    expect(forgeSlot()).not.toBeNull();
    expect(forgeSlot()?.getAttribute("aria-hidden")).toBeNull();
    expect(forgeMenuShown()).toBe(false);
  });

  it("demoted: folds the pill into the … menu and keeps it mounted for that menu", async () => {
    await applyProfile({ forgeStats: "demoted" });

    expect(forgeSlot()).not.toBeNull();
    expect(forgeSlot()?.getAttribute("aria-hidden")).toBe("true");
    expect(forgeMenuShown()).toBe(true);
  });

  it("hidden: drops the slot entirely, with nothing in the … menu", async () => {
    await applyProfile({ forgeStats: "hidden" });

    expect(forgeSlot()).toBeNull();
    expect(forgeMenuShown()).toBe(false);
  });

  it("puts the pill back when the profile returns to shown", async () => {
    await applyProfile({ forgeStats: "hidden" });
    await applyProfile({});

    expect(forgeSlot()?.getAttribute("aria-hidden")).toBeNull();
    expect(forgeMenuShown()).toBe(false);
  });

  it("never draws the pill for a folder without a repository, whatever the level", async () => {
    act(() => {
      useProjectStore.setState({ currentProject: { ...PREVIEW_PROJECT, gitBacked: false } });
    });
    await applyProfile({ forgeStats: "shown" });

    expect(forgeSlot()).toBeNull();
  });
});

describe("Toolbar items under the project's toolbar (#13783)", () => {
  const resumeSlot = () => document.querySelector('[data-toolbar-button-id="resume-sessions"]');
  // Resume sessions sits in the right-hand row by default, as forge stats does.
  const rightMenuShown = forgeMenuShown;

  it("demoted: folds a built-in button into … for this project, writing nothing app-wide", async () => {
    const layoutBefore = useToolbarPreferencesStore.getState().layout;
    expect(resumeSlot()?.getAttribute("aria-hidden")).toBeNull();

    await applyProfile({ resumeSessions: "demoted" });

    expect(resumeSlot()?.getAttribute("aria-hidden")).toBe("true");
    expect(rightMenuShown()).toBe(true);
    expect(useToolbarPreferencesStore.getState().layout).toBe(layoutBefore);
  });

  it("turned off: draws the app-wide toolbar while keeping the profile's choices", async () => {
    await applyProfile({ resumeSessions: "demoted", forgeStats: "hidden" }, false);

    expect(resumeSlot()?.getAttribute("aria-hidden")).toBeNull();
    expect(rightMenuShown()).toBe(false);
    expect(forgeSlot()).not.toBeNull();
    expect(useProjectPresentationStore.getState().levels).toEqual({
      resumeSessions: "demoted",
      forgeStats: "hidden",
    });
  });

  it("explicitly shown: keeps a button on this project's toolbar while it's off app-wide", async () => {
    act(() => {
      useToolbarPreferencesStore.setState((state) => ({
        layout: { ...state.layout, pinnedButtons: { ...state.layout.pinnedButtons, "resume-sessions": false }, },
      }));
    });
    await settle();
    expect(resumeSlot()).toBeNull();

    await applyProfile({ resumeSessions: "shown" });
    expect(resumeSlot()?.getAttribute("aria-hidden")).toBeNull();
    // The app-wide pin is untouched: other projects still go without it.
    expect(useToolbarPreferencesStore.getState().layout.pinnedButtons["resume-sessions"]).toBe(false);

    await applyProfile({ resumeSessions: "shown" }, false);
    expect(resumeSlot()).toBeNull();
  });
});

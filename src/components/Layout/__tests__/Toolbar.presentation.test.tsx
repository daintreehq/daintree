// @vitest-environment jsdom
/**
 * The forge stats pill as the presentation profile's first consumer (#13771):
 * demoted folds it into the `…` menu while it stays mounted for that menu's
 * rows, hidden drops its slot. Mounts the real Toolbar.
 */
import "../__preview__/toolbarShims";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
        layout: {
          ...state.layout,
          pinnedButtons: { ...state.layout.pinnedButtons, "resume-sessions": false },
        },
      }));
    });
    await settle();
    expect(resumeSlot()).toBeNull();

    await applyProfile({ resumeSessions: "shown" });
    expect(resumeSlot()?.getAttribute("aria-hidden")).toBeNull();
    // The app-wide pin is untouched: other projects still go without it.
    expect(useToolbarPreferencesStore.getState().layout.pinnedButtons["resume-sessions"]).toBe(
      false
    );

    await applyProfile({ resumeSessions: "shown" }, false);
    expect(resumeSlot()).toBeNull();
  });
});

describe("Toolbar menus while the project's toolbar is on (#13783)", () => {
  const setLevel = vi.fn((_feature: string, _level: string | null) => new Promise(() => {}));
  const setToolbarEnabled = vi.fn((_enabled: boolean) => new Promise(() => {}));

  let originalBridge: unknown;

  beforeEach(() => {
    // Writes only, swapped into the shimmed bridge: no `get`, so the store
    // never pulls over the state each test sets.
    originalBridge = Reflect.get(window.electron, "projectPresentation");
    Reflect.set(window.electron, "projectPresentation", { setLevel, setToolbarEnabled });
    setLevel.mockClear();
    setToolbarEnabled.mockClear();
  });

  afterEach(() => {
    Reflect.set(window.electron, "projectPresentation", originalBridge);
  });

  async function openEmptySpaceMenu(): Promise<HTMLElement> {
    fireEvent.contextMenu(screen.getByRole("toolbar", { name: "Main toolbar" }));
    return screen.findByRole("menu", { name: "Toolbar buttons" });
  }

  it("demotes from the empty-space menu through the profile, writing nothing app-wide", async () => {
    await applyProfile({}, true);
    const layoutBefore = useToolbarPreferencesStore.getState().layout;

    const menu = await openEmptySpaceMenu();
    const toggle = within(menu).getByRole("menuitemcheckbox", {
      name: "Use this project's toolbar",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // Not the profile's to place: listed, but not changeable from here.
    expect(
      within(menu)
        .getByRole("menuitemcheckbox", { name: /Settings/ })
        .getAttribute("data-disabled")
    ).not.toBeNull();

    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /Resume session/ }));

    expect(setLevel).toHaveBeenCalledExactlyOnceWith("resumeSessions", "demoted");
    expect(useToolbarPreferencesStore.getState().layout).toBe(layoutBefore);
  });

  it("re-checks a demoted button as explicitly shown for this project", async () => {
    await applyProfile({ resumeSessions: "demoted" });

    const menu = await openEmptySpaceMenu();
    const row = within(menu).getByRole("menuitemcheckbox", { name: /Resume session/ });
    expect(row.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(row);

    expect(setLevel).toHaveBeenCalledExactlyOnceWith("resumeSessions", "shown");
  });

  it("turns the project's toolbar off from the toggle", async () => {
    await applyProfile({ resumeSessions: "demoted" });

    const menu = await openEmptySpaceMenu();
    fireEvent.click(
      within(menu).getByRole("menuitemcheckbox", { name: "Use this project's toolbar" })
    );

    expect(setToolbarEnabled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("unpins a demotable button from its own menu into … for this project only", async () => {
    await applyProfile({}, true);
    const layoutBefore = useToolbarPreferencesStore.getState().layout;
    const slot = document.querySelector('[data-toolbar-button-id="resume-sessions"]')!;

    fireEvent.contextMenu(slot.querySelector("button")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Unpin from toolbar/ }));

    expect(setLevel).toHaveBeenCalledExactlyOnceWith("resumeSessions", "demoted");
    expect(useToolbarPreferencesStore.getState().layout).toBe(layoutBefore);
  });

  it("keeps the app-wide menu when the project's toolbar is off", async () => {
    await applyProfile({ resumeSessions: "demoted" }, false);

    const menu = await openEmptySpaceMenu();
    expect(
      within(menu)
        .getByRole("menuitemcheckbox", { name: "Use this project's toolbar" })
        .getAttribute("aria-checked")
    ).toBe("false");
    expect(
      within(menu)
        .getByRole("menuitemcheckbox", { name: /Settings/ })
        .getAttribute("data-disabled")
    ).toBeNull();
  });
});

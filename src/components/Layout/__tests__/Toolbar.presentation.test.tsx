// @vitest-environment jsdom
/**
 * The forge stats pill as the presentation profile's first consumer (#13771):
 * demoted folds it into the `…` menu while it stays mounted for that menu's
 * rows, hidden drops its slot. Mounts the real Toolbar.
 */
import "../__preview__/toolbarShims";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { CliAvailability } from "@shared/types";
import type { PresentationLevels } from "@shared/config/presentationProfile";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import {
  _resetProjectPresentationStoreForTest,
  useProjectPresentationStore,
} from "@/store/projectPresentationStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { useDevPreviewOfferStore, type DevPreviewOfferReason } from "@/store/devPreviewOfferStore";
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
  useWorktreeSelectionStore.setState({ activeWorktreeId: null });
  useProjectStore.setState({ currentProject: PREVIEW_PROJECT });
  await mountToolbar();
});

/** Renders and commits the first frame, before any of the mount's own loads answer. */
function renderToolbar(): void {
  const worktreeStore = createWorktreeStore();
  setCurrentViewStore(worktreeStore);
  render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <Harness />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
}

async function mountToolbar(): Promise<void> {
  renderToolbar();
  await settle();
}

const initialToolbarLayout = useToolbarPreferencesStore.getState().layout;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  _resetProjectPresentationStoreForTest();
  useScratchStore.setState({ scratches: [], currentScratch: null });
  useProjectStore.setState({ projects: [] });
  useVoiceRecordingStore.setState({ pendingTarget: null });
  seedViewWorkspace(undefined);
  useToolbarPreferencesStore.setState({ layout: initialToolbarLayout });
});

/** The id main seeds into a view at creation; absent, the view resolves from the current workspace. */
function seedViewWorkspace(id: string | undefined): void {
  const target = window as { __DAINTREE_INITIAL_PROJECT__?: { id: string } };
  if (id === undefined) delete target.__DAINTREE_INITIAL_PROJECT__;
  else target.__DAINTREE_INITIAL_PROJECT__ = { id };
}

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

describe("Toolbar forge stats in a workspace without a repository (#15931)", () => {
  const SCRATCH = {
    id: "scratch-15931",
    path: "/tmp/scratches/scratch-15931",
    name: "Scratch",
    createdAt: 1,
    lastOpened: 1,
  };

  const rightRowIds = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="group"][aria-label="Tools and settings"] [data-toolbar-button-id]'
      ),
      (el) => el.dataset.toolbarButtonId
    );

  async function resolveAsScratch(): Promise<void> {
    act(() => {
      useProjectStore.setState({ currentProject: null });
    });
    await settle();
    act(() => {
      useScratchStore.setState({ scratches: [SCRATCH], currentScratch: SCRATCH });
    });
    await settle();
  }

  it("holds the slot's placeholder while the view's workspace is still unknown", async () => {
    act(() => {
      useProjectStore.setState({ currentProject: null });
    });
    await settle();

    expect(forgeSlot()?.getAttribute("data-toolbar-placeholder")).toBe("true");
  });

  it("drops the slot once the view resolves as a scratch, leaving the rest of the row as it was", async () => {
    const gitRow = rightRowIds();
    expect(gitRow).toContain("forge-stats");

    await resolveAsScratch();

    expect(forgeSlot()).toBeNull();
    expect(forgeMenuShown()).toBe(false);
    expect(rightRowIds()).toEqual(gitRow.filter((id) => id !== "forge-stats"));
  });

  it("keeps the recording indicator beside its neighbours in a scratch", async () => {
    act(() => {
      useVoiceRecordingStore.setState({ pendingTarget: { panelId: "panel-15931" } });
    });
    await settle();
    const gitRow = rightRowIds();
    expect(gitRow).toContain("voice-recording");

    await resolveAsScratch();

    expect(forgeSlot()).toBeNull();
    expect(rightRowIds()).toEqual(gitRow.filter((id) => id !== "forge-stats"));
  });

  it("never holds a slot in a view that mounts as a scratch, not even on first paint", async () => {
    cleanup();
    seedViewWorkspace(SCRATCH.id);
    useProjectStore.setState({ projects: [], currentProject: null });
    useScratchStore.setState({ scratches: [SCRATCH], currentScratch: null });
    renderToolbar();

    expect(forgeSlot()).toBeNull();

    await settle();
    expect(forgeSlot()).toBeNull();
  });

  it("keeps the slot out of a scratch view while another window has a project open", async () => {
    cleanup();
    seedViewWorkspace(SCRATCH.id);
    useProjectStore.setState({ projects: [PREVIEW_PROJECT], currentProject: PREVIEW_PROJECT });
    useScratchStore.setState({ scratches: [SCRATCH], currentScratch: null });
    await mountToolbar();

    expect(forgeSlot()).toBeNull();
  });

  it("drops the slot in a view whose own project is a folder without a repository", async () => {
    const folder = { ...PREVIEW_PROJECT, id: "project-15931-folder", gitBacked: false };
    cleanup();
    seedViewWorkspace(folder.id);
    await mountToolbar();
    // Its own row answers before the broadcast pointer names it.
    act(() => {
      useProjectStore.setState({ projects: [folder], currentProject: null });
    });
    await settle();

    expect(forgeSlot()).toBeNull();
  });

  it("keeps the pill in a project view while another window has a scratch open", async () => {
    cleanup();
    seedViewWorkspace(PREVIEW_PROJECT.id);
    useProjectStore.setState({ projects: [PREVIEW_PROJECT], currentProject: PREVIEW_PROJECT });
    useScratchStore.setState({ scratches: [SCRATCH], currentScratch: SCRATCH });
    await mountToolbar();

    expect(forgeSlot()).not.toBeNull();
    expect(forgeSlot()?.getAttribute("data-toolbar-placeholder")).toBeNull();
  });

  it("holds the slot in a view whose own workspace hasn't resolved, whatever scratches exist", async () => {
    cleanup();
    seedViewWorkspace("project-15931-pending");
    useScratchStore.setState({ scratches: [SCRATCH], currentScratch: SCRATCH });
    await mountToolbar();
    // Main hasn't bound this view to its project yet.
    act(() => {
      useProjectStore.setState({ projects: [], currentProject: null });
    });
    await settle();

    expect(forgeSlot()?.getAttribute("data-toolbar-placeholder")).toBe("true");
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

describe("Toolbar dev preview under the project's choice (#14069)", () => {
  // Whether the row holds the button at all. Where on the row it lands, or
  // whether the width budget folds it into `…`, is the overflow engine's
  // business and is pinned by its own suites.
  const devSlot = () => document.querySelector('[data-toolbar-button-id="dev-server"]');

  async function offer(reason: DevPreviewOfferReason): Promise<void> {
    act(() => {
      useDevPreviewOfferStore.setState({ reason });
    });
    await settle();
  }

  // A profile from before #11667 still carries the button with no pin entry.
  function grandfatheredLayout(pinned?: boolean): void {
    act(() => {
      useToolbarPreferencesStore.setState((state) => ({
        layout: {
          ...state.layout,
          leftButtons: [...state.layout.leftButtons, "dev-server"],
          pinnedButtons:
            pinned === undefined
              ? state.layout.pinnedButtons
              : { ...state.layout.pinnedButtons, "dev-server": pinned },
        },
      }));
    });
  }

  afterEach(() => {
    useDevPreviewOfferStore.setState({ reason: "unknown" });
  });

  it("takes a leftover button away where nothing offers the dev preview, writing nothing", async () => {
    grandfatheredLayout();
    await applyProfile({});
    expect(devSlot()).not.toBeNull();
    const layoutBefore = useToolbarPreferencesStore.getState().layout;

    await offer(null);
    expect(devSlot()).toBeNull();
    expect(useToolbarPreferencesStore.getState().layout).toBe(layoutBefore);

    await offer("web-project");
    expect(devSlot()).not.toBeNull();
  });

  it("never adds the button for a detected web project alone", async () => {
    await offer("web-project");
    await applyProfile({});
    expect(devSlot()).toBeNull();
  });

  it("explicitly shown: puts it on this project's toolbar with no app-wide slot, whatever the toggle", async () => {
    await offer(null);
    const layoutBefore = useToolbarPreferencesStore.getState().layout;

    await applyProfile({ devServer: "shown" }, false);

    expect(devSlot()).not.toBeNull();
    expect(useToolbarPreferencesStore.getState().layout).toBe(layoutBefore);
  });

  it("explicitly hidden: drops even a button the user pinned", async () => {
    grandfatheredLayout(true);
    await applyProfile({ devServer: "hidden" });
    expect(devSlot()).toBeNull();
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

  it("shows a leftover dev preview this project hides by default, in this project only (#14069)", async () => {
    act(() => {
      useToolbarPreferencesStore.setState((state) => ({
        layout: { ...state.layout, leftButtons: [...state.layout.leftButtons, "dev-server"] },
      }));
      useDevPreviewOfferStore.setState({ reason: null });
    });
    try {
      await applyProfile({});
      const layoutBefore = useToolbarPreferencesStore.getState().layout;

      const menu = await openEmptySpaceMenu();
      const row = within(menu).getByRole("menuitemcheckbox", { name: /Dev preview/ });
      expect(row.getAttribute("aria-checked")).toBe("false");
      fireEvent.click(row);

      // The layout already holds its slot, so an app-wide write would change nothing.
      expect(setLevel).toHaveBeenCalledExactlyOnceWith("devServer", "shown");
      expect(useToolbarPreferencesStore.getState().layout).toBe(layoutBefore);
    } finally {
      useDevPreviewOfferStore.setState({ reason: "unknown" });
    }
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

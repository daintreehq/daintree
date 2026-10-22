// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";
import {
  PROJECT_SURFACE_SLOTS,
  type ProjectSurfaceChoiceUpdate,
  type ProjectSurfaceChoices,
  type ProjectSurfaceSlot,
  type ProjectSurfaceSlotState,
} from "@shared/types/plugin";

/**
 * Only `emptyCanvas` is catalogued, so this file declares a second slot for
 * itself: one plugin setting up several slots is the case the shared notice is
 * for.
 */
vi.mock("@shared/types/plugin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/types/plugin")>();
  const catalogue = {
    ...actual.PROJECT_SURFACE_SLOT_CATALOGUE,
    projectHome: {
      mode: "exclusive",
      claim: "view",
      label: "Home",
      stockLabel: "Overview",
      noun: "home",
      switchPlacement: "above",
    },
  };
  const slots = Object.keys(catalogue);
  return {
    ...actual,
    PROJECT_SURFACE_SLOT_CATALOGUE: catalogue,
    PROJECT_SURFACE_SLOTS: slots,
    isProjectSurfaceSlot: (value: unknown) => slots.some((slot) => slot === value),
  };
});

vi.mock("@/components/Plugin/PluginViewContent", () => ({
  makePluginViewContent: () => () => null,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectSurfaceFrame } from "../ProjectSurfaceFrame";
import {
  _resetPluginProjectSurfacesStoreForTest,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";
import {
  __resetProjectPluginStoreForTesting,
  useProjectPluginStore,
} from "@/store/projectPluginStore";

/** The slot this file's catalogue mock adds after `emptyCanvas`. */
const HOME = PROJECT_SURFACE_SLOTS[1]!;
const OWNER = "project__p1__acme.dash";
const kindOf = (slot: ProjectSurfaceSlot) => `project:p1/acme.dash/${slot}`;

/**
 * One value per slot. Built from entries because `HOME` types as the one slot
 * the real catalogue declares, so a literal naming both reads as one key twice.
 */
function bySlot<T>(canvas: T, home: T): Partial<Record<ProjectSurfaceSlot, T>> {
  return Object.fromEntries([
    ["emptyCanvas", canvas],
    [HOME, home],
  ]);
}

const kept = { pluginId: "acme.dash", choice: "surface" as const, decidedAt: 1 };

function ownedSlot(slot: ProjectSurfaceSlot, pluginId = OWNER): ProjectSurfaceSlotState {
  return {
    mode: "exclusive",
    options: [
      {
        pluginId,
        scope: "project",
        value: { kind: "view", viewId: slot, panelKindId: kindOf(slot) },
      },
    ],
    defaultOptionId: pluginId,
    refused: [],
  };
}

const setProjectSurfaceChoices = vi.fn((_updates: ProjectSurfaceChoiceUpdate[]) =>
  Promise.resolve({
    projectId: "p1",
    revision: 1,
    slots: bySlot(ownedSlot("emptyCanvas"), ownedSlot(HOME)),
    choices: bySlot(kept, kept),
  })
);

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

beforeEach(() => {
  _resetPluginProjectSurfacesStoreForTest();
  setProjectSurfaceChoices.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: { setProjectSurfaceChoices } },
  });
  for (const slot of ["emptyCanvas", HOME] as const) {
    registerPanelKind({
      id: kindOf(slot),
      name: `${slot} view`,
      iconId: "puzzle",
      color: "#ffffff",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: OWNER,
      componentPath: `plugin://acme.dash/1/${slot}.js`,
    });
  }
  act(() => {
    useProjectPluginStore.setState({
      plugins: [
        {
          projectId: "p1",
          id: "acme.dash",
          instanceId: OWNER,
          displayName: "Acme Dashboard",
          version: "1.0.0",
          capabilities: [],
          dirName: "dash",
          state: "active",
          muted: false,
          collidesWithGlobal: false,
        },
      ],
    });
  });
});

afterEach(() => {
  unregisterPanelKind(kindOf("emptyCanvas"));
  unregisterPanelKind(kindOf(HOME));
  _resetPluginProjectSurfacesStoreForTest();
  __resetProjectPluginStoreForTesting();
  Reflect.deleteProperty(window, "electron");
});

function seed(choices: ProjectSurfaceChoices = {}, homeOwner = OWNER) {
  act(() => {
    usePluginProjectSurfacesStore.setState({
      slots: bySlot(ownedSlot("emptyCanvas"), ownedSlot(HOME, homeOwner)),
      surfaces: bySlot(
        { pluginId: OWNER, panelKindId: kindOf("emptyCanvas") },
        { pluginId: homeOwner, panelKindId: kindOf(HOME) }
      ),
      choices,
      choicesLoaded: true,
    });
  });
}

function Frames({ slots }: { slots: ProjectSurfaceSlot[] }) {
  return (
    <TooltipProvider>
      {slots.map((slot, index) => (
        <ProjectSurfaceFrame key={`${slot}-${index}`} slot={slot}>
          <div />
        </ProjectSurfaceFrame>
      ))}
    </TooltipProvider>
  );
}

/** Each frame on screen, by slot, with the question it is asking if any. */
const frames = () =>
  screen.getAllByTestId("project-surface-frame").map((frame) => ({
    slot: frame.getAttribute("data-project-surface-slot"),
    notice: frame.querySelector(':scope > [role="status"]'),
  }));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the shared consent notice", () => {
  it("asks once for every slot a plugin set up, however many of its frames are up", async () => {
    seed();
    render(<Frames slots={["emptyCanvas", HOME]} />);

    // One question, in the first framed slot, naming both.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    const [canvas, home] = frames();
    expect(canvas?.notice?.textContent).toContain(
      "Acme Dashboard set up this project: Empty canvas, Home"
    );
    expect(home?.notice).toBeNull();

    await act(async () => {
      within(screen.getByRole("status")).getByRole("button", { name: "Keep" }).click();
      await settle();
    });

    // One answer, one write, each slot naming the plugin it was about.
    expect(setProjectSurfaceChoices).toHaveBeenCalledTimes(1);
    expect(setProjectSurfaceChoices).toHaveBeenCalledWith([
      { slot: "emptyCanvas", choice: "surface", ownerId: OWNER },
      { slot: HOME, choice: "surface", ownerId: OWNER },
    ]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("lists and answers only the slots still unanswered", async () => {
    // The canvas was switched to Daintree's own earlier; Home is new.
    seed({ emptyCanvas: { pluginId: "acme.dash", choice: "stock", decidedAt: 1 } });
    render(<Frames slots={["emptyCanvas", HOME]} />);

    const [canvas, home] = frames();
    expect(canvas?.notice).toBeNull();
    expect(home?.notice?.textContent).toContain("Acme Dashboard set up this project: Home");

    await act(async () => {
      within(screen.getByRole("status")).getByRole("button", { name: "Keep" }).click();
      await settle();
    });

    // Keeping the new slot never turns the old one back on.
    expect(setProjectSurfaceChoices).toHaveBeenCalledWith([
      { slot: HOME, choice: "surface", ownerId: OWNER },
    ]);
  });

  it("asks a slot's new owner about that slot alone", () => {
    seed(bySlot(kept, kept), "project__p1__beta.home");
    render(<Frames slots={["emptyCanvas", HOME]} />);

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(frames()[1]?.notice?.textContent).toContain("beta.home set up this project: Home");
  });

  it("hands the question to the next frame when its frame goes away", () => {
    seed();
    const { rerender } = render(<Frames slots={["emptyCanvas", HOME]} />);
    expect(frames()[0]?.notice).not.toBeNull();

    rerender(<Frames slots={[HOME]} />);

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(frames()[0]?.slot).toBe(HOME);
    expect(frames()[0]?.notice?.textContent).toContain("set up this project: Empty canvas, Home");
  });

  it("asks once when the same slot is framed twice, and keeps asking when one goes", () => {
    seed(Object.fromEntries([[HOME, kept]]));
    const { rerender } = render(<Frames slots={["emptyCanvas", "emptyCanvas"]} />);

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(frames()[0]?.notice).not.toBeNull();

    rerender(<Frames slots={["emptyCanvas"]} />);
    expect(screen.getAllByRole("status")).toHaveLength(1);

    rerender(<Frames slots={[]} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("asks nothing until the answers are known", () => {
    seed();
    act(() => usePluginProjectSurfacesStore.setState({ choicesLoaded: false }));
    render(<Frames slots={["emptyCanvas", HOME]} />);

    expect(screen.queryByRole("status")).toBeNull();
  });
});

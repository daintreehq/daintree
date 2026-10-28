// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";

/**
 * The frame, the notice and the save failure are worded entirely from the
 * slot's catalogue declaration, so a slot that declares other words — and the
 * strip on the other side — gets them without a line of slot-specific code.
 * Only `emptyCanvas` is catalogued, so its declaration is swapped here rather
 * than a new slot being added to the production catalogue.
 */
vi.mock("@shared/types/plugin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/types/plugin")>();
  const emptyCanvas = {
    mode: "exclusive",
    claim: "view",
    label: "Project home",
    stockLabel: "Overview",
    noun: "home",
    switchPlacement: "below",
  } as const;
  return {
    ...actual,
    PROJECT_SURFACE_SLOT_CATALOGUE: { ...actual.PROJECT_SURFACE_SLOT_CATALOGUE, emptyCanvas },
    // The notice reads a slot's words through the resolver, which closes over
    // the real catalogue, so the swapped declaration goes through it too.
    projectSurfaceSlotDescriptor: (
      slot: Parameters<typeof actual.projectSurfaceSlotDescriptor>[0]
    ) => (slot === "emptyCanvas" ? emptyCanvas : actual.projectSurfaceSlotDescriptor(slot)),
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

const KIND_ID = "project:p1/acme.dash/overview";
const OWNER = "project__p1__acme.dash";

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
  registerPanelKind({
    id: KIND_ID,
    name: "Mission Control",
    iconId: "puzzle",
    color: "#ffffff",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: OWNER,
    componentPath: "plugin://acme.dash/1/overview.js",
  });
  act(() => {
    usePluginProjectSurfacesStore.setState({
      slots: {
        emptyCanvas: {
          mode: "exclusive",
          options: [
            {
              pluginId: OWNER,
              scope: "project",
              value: { kind: "view", viewId: "overview", panelKindId: KIND_ID },
            },
          ],
          defaultOptionId: OWNER,
          refused: [],
        },
      },
      surfaces: { emptyCanvas: { pluginId: OWNER, panelKindId: KIND_ID } },
      choicesLoaded: true,
    });
  });
});

afterEach(() => {
  unregisterPanelKind(KIND_ID);
  _resetPluginProjectSurfacesStoreForTest();
});

const renderFrame = () =>
  render(
    <TooltipProvider>
      <ProjectSurfaceFrame slot="emptyCanvas">
        <div data-testid="content" />
      </ProjectSurfaceFrame>
    </TooltipProvider>
  );

describe("ProjectSurfaceFrame driven by its slot's declaration", () => {
  it("names the strip, the switch and the way back from the declaration", () => {
    renderFrame();

    const strip = screen.getByRole("group", { name: "Project home" });
    const radios = within(
      within(strip).getByRole("radiogroup", { name: "Home view" })
    ).getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["Mission Control", "Overview"]);
    expect(screen.getByRole("status").textContent).toContain("set up this project: Project home");
  });

  it("puts the strip on the side the slot declares, with the question between it and the region", () => {
    renderFrame();

    const frame = screen.getByTestId("project-surface-frame");
    const order = Array.from(frame.children).map(
      (child) => child.getAttribute("data-testid") ?? child.getAttribute("role")
    );
    expect(order).toEqual(["project-surface-region", "status", "project-surface-strip"]);
  });

  it("says which choice didn't save in the slot's own words", () => {
    act(() => {
      usePluginProjectSurfacesStore.setState({
        failedSave: {
          updates: [{ slot: "emptyCanvas", choice: "stock" }],
          owners: { emptyCanvas: "acme.dash" },
        },
      });
    });
    renderFrame();

    expect(screen.getByText("Couldn't save the home choice")).toBeTruthy();
  });
});

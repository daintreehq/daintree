// @vitest-environment jsdom
import path from "node:path";
import { memo, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginTourDescriptor } from "@shared/types/plugin";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";

const { prepareMock, registerRootMock } = vi.hoisted(() => ({
  prepareMock: vi.fn(() => Promise.resolve()),
  registerRootMock: vi.fn((_node: Element | null) => () => {}),
}));
vi.mock("@/services/plugin/pluginStyleContract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/plugin/pluginStyleContract")>()),
  preparePluginStyles: prepareMock,
  registerPluginStyleRoot: registerRootMock,
}));

vi.mock("@/components/ui/AppDialog", () => {
  const AppDialog = ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null;
  AppDialog.Header = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  AppDialog.Title = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => null;
  AppDialog.Footer = () => null;
  return { AppDialog };
});
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("@/utils/rendererSentry", () => ({
  captureRendererException: vi.fn(),
  getRendererSentryConsent: vi.fn(() => ({ level: "off", hasSeenPrompt: false })),
}));

import {
  buildPluginTourDefinition,
  createPluginTourRegistration,
  readPluginTourModule,
} from "../pluginTours";
import { TourDialog } from "../TourDialog";

// The installed-plugin fixture: a hand-written module importing `react` and
// `@daintreehq/tour/*` bare, as a raw plugin module does through the import map.
const FIXTURE_MODULE = path.resolve(
  __dirname,
  "../../../../plugins/fixtures/installed/acme.welcome-tour/dist/tour.js"
);

const createdAudio: string[] = [];
/** Narration that never loads: the player must carry on with captions. */
class BlockedAudio {
  src: string;
  preload = "";
  currentTime = 0;
  muted = false;
  constructor(src: string) {
    this.src = src;
    createdAudio.push(src);
  }
  play() {
    return Promise.reject(new Error("NotAllowedError"));
  }
  pause() {}
  addEventListener() {}
  removeEventListener() {}
}

function fixtureTour(overrides: Partial<PluginTourDescriptor> = {}): PluginTourDescriptor {
  return {
    id: "acme.welcome-tour.welcome",
    pluginId: "acme.welcome-tour",
    pluginName: "Acme Site Builder",
    title: "Welcome Tour",
    moduleUrl: FIXTURE_MODULE,
    chapters: [
      {
        id: "intro",
        duration: 6,
        cues: { title: 0.5, pages: 2.5 },
        captions: [{ start: 0, end: 2.5, text: "This is the Acme site builder." }],
        audioUrl: "plugin://pi-abc/__dtv-3/tours/welcome/intro.ogg",
      },
      {
        id: "publish",
        duration: 5,
        cues: { publish: 1 },
        captions: [{ start: 0, end: 5, text: "Publish when you're ready." }],
        audioUrl: "plugin://pi-abc/__dtv-3/__dta/welcome/publish",
      },
    ],
    ...overrides,
  };
}

describe("plugin tours", () => {
  beforeEach(() => {
    createdAudio.length = 0;
    prepareMock.mockClear();
    registerRootMock.mockClear();
    vi.stubGlobal("Audio", BlockedAudio);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers from the descriptor alone, loading nothing until the tour opens", () => {
    const registration = createPluginTourRegistration(fixtureTour());
    expect(registration.summary).toEqual({
      id: "acme.welcome-tour.welcome",
      title: "Welcome Tour",
      minutes: 1,
      chapterTitles: ["intro", "publish"],
    });
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("loads the fixture's two chapters in manifest order with its timing and audio", async () => {
    const tour = await createPluginTourRegistration(fixtureTour()).load();
    expect(prepareMock).toHaveBeenCalledWith(FIXTURE_MODULE);
    expect(tour.id).toBe("acme.welcome-tour.welcome");
    expect(tour.chapters.map((chapter) => [chapter.id, chapter.title])).toEqual([
      ["intro", "Build your pages"],
      ["publish", "Go live"],
    ]);
    const timings = tour.resolveTimings("mac");
    expect(timings.map((timing) => timing.audioUrl)).toEqual([
      "plugin://pi-abc/__dtv-3/tours/welcome/intro.ogg",
      "plugin://pi-abc/__dtv-3/__dta/welcome/publish",
    ]);
    expect(timings[0]).toMatchObject({ duration: 6, cues: { title: 0.5, pages: 2.5 } });
    // Each opening gets its own copies; the player may not reach back into the descriptor.
    expect(tour.resolveTimings("mac")[0]).not.toBe(timings[0]);
  });

  it("plays a scene inside the plugin style root, with the dialog chrome outside it", async () => {
    const tour = await createPluginTourRegistration(fixtureTour()).load();
    await act(async () => {
      render(
        <TourDialog
          isOpen
          tour={tour}
          onClose={vi.fn()}
          initialChapter={0}
          initialMuted={false}
          onChapterReached={vi.fn()}
          onCompleted={vi.fn()}
          onMutedChange={vi.fn()}
        />
      );
    });

    const scene = screen.getByTestId("acme-intro");
    const root = scene.closest(`[${PLUGIN_STYLE_ROOT_ATTRIBUTE}]`);
    expect(root).not.toBeNull();
    expect(registerRootMock).toHaveBeenCalledWith(root);
    // Chapter headings and controls are the host's, not the plugin's.
    expect(
      screen.getByRole("heading", { level: 3 }).closest(`[${PLUGIN_STYLE_ROOT_ATTRIBUTE}]`)
    ).toBeNull();
    // The plugin's own category-token classes reach the DOM for the runtime to compile.
    expect(scene.innerHTML).toContain("text-category-amber-text");
    // Narration that can't play leaves the chapter on screen, captioned.
    expect(createdAudio).toContain("plugin://pi-abc/__dtv-3/tours/welcome/intro.ogg");
  });

  it("fails the load when the module can't be imported", async () => {
    const registration = createPluginTourRegistration(
      fixtureTour({ moduleUrl: path.resolve(__dirname, "missing-tour-module.js") })
    );
    await expect(registration.load()).rejects.toThrow();
  });

  it("names every chapter the module has no scene for", () => {
    expect(() =>
      readPluginTourModule({ default: { scenes: { intro: () => null } } }, fixtureTour())
    ).toThrow(/"publish"/);
    expect(() => readPluginTourModule({}, fixtureTour())).toThrow(/default-export/);
    expect(() => readPluginTourModule({ default: {} }, fixtureTour())).toThrow(/scenes/);
  });

  it("accepts memo components and titles an untitled chapter by its id", () => {
    const module = readPluginTourModule(
      { default: { scenes: { intro: memo(() => null), publish: () => null } } },
      fixtureTour()
    );
    const tour = buildPluginTourDefinition(fixtureTour(), module);
    expect(tour.chapters.map((chapter) => chapter.title)).toEqual(["intro", "publish"]);
    expect(tour.mockKit).toBeUndefined();
  });
});

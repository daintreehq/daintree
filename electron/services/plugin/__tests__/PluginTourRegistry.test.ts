import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPluginTourRegistry,
  getPluginTourRemoteAudio,
  getPluginTours,
  onPluginToursChanged,
  registerPluginTours,
  unregisterPluginTours,
} from "../PluginTourRegistry.js";
import { parsePluginManifestForLoad } from "../../../schemas/plugin.js";
import type { PluginTourContribution } from "../../../../shared/types/plugin.js";

const FIXTURE_MANIFEST = path.resolve(
  __dirname,
  "../../../../plugins/fixtures/installed/acme.welcome-tour/plugin.json"
);

/** The fixture's tours, through the same parse `loadPlugin` runs. */
function fixtureTours(): PluginTourContribution[] {
  const { result, droppedTourIssues } = parsePluginManifestForLoad(
    "user",
    JSON.parse(readFileSync(FIXTURE_MANIFEST, "utf-8"))
  );
  expect(droppedTourIssues).toEqual([]);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data.contributes.tours;
}

const context = (generation: number) => ({
  pluginName: "Acme Site Builder",
  pluginUrl: (relative: string) => `plugin://pi-abc/__dtv-${generation}/${relative}`,
});

beforeEach(() => {
  clearPluginTourRegistry();
});

describe("PluginTourRegistry (#12773)", () => {
  it("publishes the fixture's two-chapter tour with its module and audio resolved", () => {
    registerPluginTours("acme.welcome-tour", fixtureTours(), context(3));
    const [tour] = getPluginTours();
    expect(tour).toMatchObject({
      id: "acme.welcome-tour.welcome",
      pluginId: "acme.welcome-tour",
      pluginName: "Acme Site Builder",
      title: "Welcome Tour",
      moduleUrl: "plugin://pi-abc/__dtv-3/dist/tour.js",
    });
    expect(tour!.panelKind).toBeUndefined();
    expect(tour!.chapters.map((chapter) => [chapter.id, chapter.audioUrl])).toEqual([
      // Bundled narration resolves from the plugin root.
      ["intro", "plugin://pi-abc/__dtv-3/tours/welcome/intro.ogg"],
      // Remote narration never reaches the renderer as its real URL.
      ["publish", "plugin://pi-abc/__dtv-3/__dta/welcome/publish"],
    ]);
    expect(tour!.chapters[0]).toMatchObject({ duration: 6, cues: { title: 0.5, pages: 2.5 } });
  });

  it("keeps the real remote URL and declared hosts for the audio route alone", () => {
    registerPluginTours("acme.welcome-tour", fixtureTours(), context(3));
    const remote = getPluginTourRemoteAudio("acme.welcome-tour", "welcome", "publish");
    expect(remote?.url).toBe("https://cdn.example.com/tours/welcome/publish.ogg");
    expect([...remote!.hosts]).toEqual(["cdn.example.com"]);
    // Bundled chapters and unknown names have no remote source.
    expect(getPluginTourRemoteAudio("acme.welcome-tour", "welcome", "intro")).toBeUndefined();
    expect(getPluginTourRemoteAudio("acme.welcome-tour", "other", "publish")).toBeUndefined();
    expect(getPluginTourRemoteAudio("acme.other", "welcome", "publish")).toBeUndefined();
  });

  it("keeps a silent chapter silent", () => {
    const [tour] = fixtureTours();
    registerPluginTours(
      "acme.quiet",
      [{ ...tour!, chapters: [{ ...tour!.chapters[0]!, audioUrl: null }] }],
      context(1)
    );
    expect(getPluginTours()[0]!.chapters[0]!.audioUrl).toBeNull();
  });

  it("replaces a plugin's tours on reload and drops them on unload", () => {
    registerPluginTours("acme.welcome-tour", fixtureTours(), context(3));
    registerPluginTours("acme.welcome-tour", fixtureTours(), context(4));
    expect(getPluginTours().map((tour) => tour.moduleUrl)).toEqual([
      "plugin://pi-abc/__dtv-4/dist/tour.js",
    ]);

    unregisterPluginTours("acme.welcome-tour");
    expect(getPluginTours()).toEqual([]);
    expect(getPluginTourRemoteAudio("acme.welcome-tour", "welcome", "publish")).toBeUndefined();
  });

  it("hands out copies, so a reader can't rewrite the registry", () => {
    registerPluginTours("acme.welcome-tour", fixtureTours(), context(3));
    getPluginTours()[0]!.chapters[0]!.cues.title = 99;
    expect(getPluginTours()[0]!.chapters[0]!.cues.title).toBe(0.5);
  });

  it("tells listeners when the set changes, and only then", () => {
    const listener = vi.fn();
    const unsubscribe = onPluginToursChanged(listener);
    registerPluginTours("acme.welcome-tour", fixtureTours(), context(3));
    unregisterPluginTours("acme.welcome-tour");
    unregisterPluginTours("acme.welcome-tour");
    registerPluginTours("acme.empty", [], context(1));
    unsubscribe();
    registerPluginTours("acme.welcome-tour", fixtureTours(), context(3));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

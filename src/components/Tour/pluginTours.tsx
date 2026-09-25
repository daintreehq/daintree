import { useCallback, type ComponentType } from "react";
import type { TourChapterTiming } from "@daintreehq/tour";
import type { MockKit } from "@daintreehq/tour/mock-app";
import type { PluginTourDescriptor } from "@shared/types/plugin";
import {
  PLUGIN_STYLE_ROOT_PROPS,
  preparePluginStyles,
  registerPluginStyleRoot,
} from "@/services/plugin/pluginStyleContract";
import type { TourDefinition, TourRegistration, TourSummary } from "./tourDefinition";

/**
 * What a plugin tour's `componentPath` module default-exports (#12773). The
 * manifest owns timing, captions and audio; the module owns the pictures.
 */
export interface PluginTourModule {
  /** One zero-prop scene per manifest chapter, keyed by chapter id. */
  scenes: Record<string, ComponentType>;
  /** Chapter titles by id; a chapter without one is titled by its id. */
  chapterTitles?: Record<string, string>;
  /** Agents, states and CI marks the mockup kit draws from. */
  mockKit?: MockKit;
}

/** Same bound a plugin view's import gets: a wedged `plugin://` read must not hold the tour. */
const PLUGIN_TOUR_IMPORT_TIMEOUT_MS = 10_000;

// Module scope rather than inline: a raw `import()` in a function body bails
// React Compiler for that function, as in `PluginViewContent`.
const importTourModule = (url: string): Promise<unknown> => import(/* @vite-ignore */ url);

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), PLUGIN_TOUR_IMPORT_TIMEOUT_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function isComponent(value: unknown): value is ComponentType {
  // Plain functions, plus the objects `memo` and `forwardRef` return.
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMockKit(value: unknown): value is MockKit {
  return isRecord(value);
}

/** Check a loaded module against {@link PluginTourModule}, naming what is missing. */
export function readPluginTourModule(
  module: unknown,
  tour: PluginTourDescriptor
): PluginTourModule {
  const exported = isRecord(module) ? module.default : undefined;
  if (!isRecord(exported)) {
    throw new Error(
      `Tour "${tour.id}": ${tour.moduleUrl} must default-export { scenes, chapterTitles?, mockKit? }`
    );
  }
  const { scenes, chapterTitles, mockKit } = exported;
  if (!isRecord(scenes)) {
    throw new Error(`Tour "${tour.id}": the module's default export has no scenes object`);
  }
  const components: Record<string, ComponentType> = {};
  const missing: string[] = [];
  for (const chapter of tour.chapters) {
    const scene = scenes[chapter.id];
    if (isComponent(scene)) components[chapter.id] = scene;
    else missing.push(`"${chapter.id}"`);
  }
  if (missing.length > 0) {
    throw new Error(`Tour "${tour.id}": no scene component for chapter ${missing.join(", ")}`);
  }
  const titles: Record<string, string> = {};
  if (isRecord(chapterTitles)) {
    for (const [id, title] of Object.entries(chapterTitles)) {
      if (typeof title === "string") titles[id] = title;
    }
  }
  return {
    scenes: components,
    chapterTitles: titles,
    mockKit: isMockKit(mockKit) ? mockKit : undefined,
  };
}

/**
 * Puts a plugin scene inside the plugin style root, so its classes compile
 * scoped exactly as a plugin view's do. The dialog's own chrome stays outside.
 */
function PluginTourSceneRoot({ Scene }: { Scene: ComponentType }) {
  // React 19 runs the returned cleanup on unmount instead of calling with null.
  const styleRootRef = useCallback(
    (node: HTMLDivElement | null) => registerPluginStyleRoot(node),
    []
  );
  return (
    <div ref={styleRootRef} {...PLUGIN_STYLE_ROOT_PROPS} className="absolute inset-0">
      <Scene />
    </div>
  );
}

function inPluginStyleRoot(Scene: ComponentType): ComponentType {
  function PluginTourScene() {
    return <PluginTourSceneRoot Scene={Scene} />;
  }
  PluginTourScene.displayName = `PluginTourScene(${Scene.displayName ?? Scene.name ?? "Scene"})`;
  return PluginTourScene;
}

function chapterTitle(module: PluginTourModule, chapterId: string): string {
  const title = module.chapterTitles?.[chapterId];
  return typeof title === "string" && title.trim().length > 0 ? title : chapterId;
}

/** Joins the manifest's chapters with the module's scenes, in manifest order. */
export function buildPluginTourDefinition(
  tour: PluginTourDescriptor,
  module: PluginTourModule
): TourDefinition {
  const timings: TourChapterTiming[] = tour.chapters.map((chapter) => ({
    duration: chapter.duration,
    cues: { ...chapter.cues },
    captions: chapter.captions.map((caption) => ({ ...caption })),
    audioUrl: chapter.audioUrl,
  }));
  return {
    id: tour.id,
    title: tour.title,
    chapters: tour.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapterTitle(module, chapter.id),
      scene: inPluginStyleRoot(module.scenes[chapter.id]!),
    })),
    // Plugin timings are authored ahead of time and don't vary by keyboard.
    resolveTimings: () => timings.map((timing) => ({ ...timing })),
    ...(module.mockKit ? { mockKit: module.mockKit } : {}),
  };
}

export function pluginTourSummary(tour: PluginTourDescriptor): TourSummary {
  const seconds = tour.chapters.reduce((total, chapter) => total + chapter.duration, 0);
  return {
    id: tour.id,
    title: tour.title,
    minutes: Math.max(1, Math.round(seconds / 60)),
    // The module holds the titles and isn't loaded until the tour opens.
    chapterTitles: tour.chapters.map((chapter) => chapter.id),
  };
}

/**
 * A plugin tour as the tour host plays it. Nothing is fetched until `load()`:
 * registering a plugin's tours at startup imports no scene module.
 */
export function createPluginTourRegistration(tour: PluginTourDescriptor): TourRegistration {
  return {
    summary: pluginTourSummary(tour),
    load: async () => {
      // One deadline for both halves: style preparation is best-effort and
      // must never hold the tour open-pending on its own.
      const [module] = await withTimeout(
        Promise.all([importTourModule(tour.moduleUrl), preparePluginStyles(tour.moduleUrl)]),
        `Tour "${tour.id}": ${tour.moduleUrl} took longer than ${PLUGIN_TOUR_IMPORT_TIMEOUT_MS}ms to load`
      );
      return buildPluginTourDefinition(tour, readPluginTourModule(module, tour));
    },
  };
}

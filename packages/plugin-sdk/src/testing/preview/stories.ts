import type { ComponentType } from "react";
import type { PanelViewProps } from "../../../../../shared/types/plugin.js";
import type { ChannelFixture, MockViewHost } from "./mockViewHost.js";
import type { PreviewPanelController, PreviewPanelPropsOptions } from "./panelProps.js";

/** The host state a story renders against. */
export interface PanelStoryFixtures {
  /** Channel answers; a story's entries replace the meta's channel by channel. */
  channels?: Record<string, ChannelFixture>;
  /** Mount as a cached (background) project view. */
  viewCached?: boolean;
}

/** What `play` gets: the live host and panel, to push events or act on the DOM. */
export interface PanelStoryContext {
  host: MockViewHost;
  panel: PreviewPanelController;
  /** The marked style root the view is rendered into. */
  canvasElement: HTMLElement;
}

/**
 * The default export of a `panel.stories.tsx` (CSF3-shaped): the panel view,
 * the props every story shares, and the fixtures every story starts from.
 */
export interface PanelStoriesMeta {
  title?: string;
  component: ComponentType<PanelViewProps>;
  /** Panel props shared by every story: `initialArgs`, `stateVersion`, `worktreeId`, … */
  args?: PreviewPanelPropsOptions;
  fixtures?: PanelStoryFixtures;
}

/** One named export: one state of the panel (empty, loading, error, populated, …). */
export interface PanelStory {
  /** Display name. Defaults to the export name, split into words. */
  name?: string;
  /** Merged over the meta's args. */
  args?: PreviewPanelPropsOptions;
  /** Merged over the meta's fixtures. */
  fixtures?: PanelStoryFixtures;
  /**
   * Runs once the view has mounted and before the page reports ready — the
   * place to push events or drive the DOM into the state this story shows.
   */
  play?: (context: PanelStoryContext) => void | Promise<void>;
}

/** A stories module as imported: `import * as stories from "./panel.stories"`. */
export interface PanelStoriesModule {
  default: PanelStoriesMeta;
  [exportName: string]: unknown;
}

export interface ListedPanelStory {
  exportName: string;
  name: string;
  story: PanelStory;
}

/** `PopulatedWithErrors` → `Populated With Errors`, as CSF names stories. */
export function storyNameFromExport(exportName: string): string {
  return exportName
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .trim();
}

/** The stories in a module, in export order (or `__namedExportsOrder`, when given). */
export function listPanelStories(module: PanelStoriesModule): ListedPanelStory[] {
  const order = Array.isArray(module.__namedExportsOrder)
    ? (module.__namedExportsOrder as unknown[]).filter((n): n is string => typeof n === "string")
    : Object.keys(module);
  const stories: ListedPanelStory[] = [];
  for (const exportName of order) {
    if (exportName === "default" || exportName.startsWith("__")) continue;
    const story = module[exportName];
    if (typeof story !== "object" || story === null) continue;
    const typed = story as PanelStory;
    stories.push({ exportName, name: typed.name ?? storyNameFromExport(exportName), story: typed });
  }
  return stories;
}

/** A story with the meta folded in: what is actually mounted. */
export interface ComposedPanelStory {
  component: ComponentType<PanelViewProps>;
  args: PreviewPanelPropsOptions;
  fixtures: PanelStoryFixtures;
  play?: PanelStory["play"];
}

export function composePanelStory(
  meta: PanelStoriesMeta,
  story: PanelStory = {}
): ComposedPanelStory {
  return {
    component: meta.component,
    args: { ...meta.args, ...story.args },
    fixtures: {
      ...meta.fixtures,
      ...story.fixtures,
      channels: { ...meta.fixtures?.channels, ...story.fixtures?.channels },
    },
    ...(story.play ? { play: story.play } : {}),
  };
}

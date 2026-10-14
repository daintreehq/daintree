import {
  PREVIEW_THEMES,
  listPanelStories,
  mountPanelStory,
  type MountedPanelPreview,
  type PanelStoriesModule,
  type PreviewStyleHost,
} from "@daintreehq/plugin-sdk/testing/preview";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { createHostPreviewStyles } from "./hostPreviewStyles";
import "@/index.css";

/**
 * Plugin panel views, rendered outside Daintree from their `panel.stories.tsx`.
 *
 * Every repo plugin's stories file is picked up here. The view runs against the
 * SDK's mock view host (`@daintreehq/plugin-sdk/testing/preview`), styled by the
 * host's own plugin style runtime, under the app's `index.css` — so what renders
 * is what the panel looks like in Daintree, minus real worker data.
 *
 * Query parameters:
 *   ?plugin=sample/file-tree   which plugin's stories (path under plugins/)
 *   ?story=Populated           which named export
 *   ?theme=daintree|bondi|…    built-in theme id
 *   ?width=640&height=480      panel size in CSS px
 *
 * Readiness: `html[data-daintree-preview-ready]` is `ready` once fonts, styles
 * and the story are in, or `failed` with the reason in
 * `data-daintree-preview-failure`.
 */

const modules = import.meta.glob<PanelStoriesModule>("/plugins/**/review/panel.stories.tsx", {
  eager: true,
});

const pluginKeyOf = (file: string) =>
  file.replace(/^\/plugins\//, "").replace(/\/review\/panel\.stories\.tsx$/, "");
const byPlugin = new Map(Object.entries(modules).map(([file, mod]) => [pluginKeyOf(file), mod]));

const params = new URLSearchParams(window.location.search);
const pluginKey = params.get("plugin") ?? [...byPlugin.keys()][0];
const storiesModule = pluginKey ? byPlugin.get(pluginKey) : undefined;
if (!storiesModule) {
  throw new Error(
    `No panel.stories.tsx for "${pluginKey}". Known: ${[...byPlugin.keys()].join(", ")}`
  );
}
const stories = listPanelStories(storiesModule);
const storyName = params.get("story") ?? stories[0]?.exportName;
const story = stories.find((candidate) => candidate.exportName === storyName);
if (!story) {
  throw new Error(`No story "${storyName}". Known: ${stories.map((s) => s.exportName).join(", ")}`);
}

document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function select(label: string, options: string[], value: string, onChange: (v: string) => void) {
  const element = document.createElement("select");
  element.setAttribute("aria-label", label);
  for (const option of options) element.add(new Option(option, option, false, option === value));
  element.addEventListener("change", () => onChange(element.value));
  return element;
}

function navigate(key: string, value: string) {
  params.set(key, value);
  window.location.search = params.toString();
}

const shell = document.getElementById("root")!;
const toolbar = document.createElement("div");
toolbar.style.cssText = "display:flex;gap:8px;padding:8px;font:12px system-ui";
const container = document.createElement("div");
container.style.width = `${Number(params.get("width") ?? "640")}px`;
container.style.height = `${Number(params.get("height") ?? "480")}px`;
container.style.background = "var(--color-surface-panel)";
shell.replaceChildren(toolbar, container);

let preview: MountedPanelPreview | null = null;

toolbar.append(
  select("Plugin", [...byPlugin.keys()], pluginKey!, (value) => {
    params.delete("story");
    navigate("plugin", value);
  }),
  select(
    "Story",
    stories.map((s) => s.exportName),
    story.exportName,
    (value) => navigate("story", value)
  ),
  // In place, without a reload: the theme engine's variables are swapped on
  // the document root and readiness settles again.
  select(
    "Theme",
    PREVIEW_THEMES.map((theme) => theme.id),
    params.get("theme") ?? "daintree",
    (value) => {
      params.set("theme", value);
      window.history.replaceState(null, "", `?${params.toString()}`);
      void preview?.setTheme(value);
    }
  )
);

// A runtime that will not start is a styling failure like any other: the page
// still mounts, and reports `failed` rather than a half-styled `ready`.
const styles: PreviewStyleHost = await createHostPreviewStyles().catch((error: unknown) => {
  const reason = `the style runtime did not start: ${formatErrorMessage(error, String(error))}`;
  return { registerRoot: () => () => {}, failure: () => reason };
});
preview = mountPanelStory(storiesModule.default, story.story, {
  container,
  theme: params.get("theme") ?? "daintree",
  styles,
});

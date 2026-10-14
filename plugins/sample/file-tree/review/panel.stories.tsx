import {
  hostResponses,
  type PanelStoriesMeta,
  type PanelStory,
} from "@daintreehq/plugin-sdk/testing/preview";
import FileTreeView from "../renderer/file-tree-view";

/**
 * The sample file browser's states, for `@daintreehq/plugin-sdk/testing/preview`.
 *
 * Like `renderer/`, `review/` is skipped by the build, so nothing here ships.
 * Each named export is one state of the panel, rendered against a mock view
 * host instead of a running Daintree — open them with `plugin-panel-preview.html`
 * (`?plugin=sample/file-tree&story=Populated`).
 */

const ROOT = "/work/repo";

const LISTINGS: Record<string, unknown[]> = {
  [ROOT]: [
    { name: "src", isDirectory: true },
    { name: "docs", isDirectory: true },
    { name: ".env", isDirectory: false, size: 120 },
    { name: "package.json", isDirectory: false, size: 1450 },
    { name: "README.md", isDirectory: false, size: 3200 },
  ],
  [`${ROOT}/src`]: [
    { name: "index.ts", isDirectory: false, size: 880 },
    { name: "panel.tsx", isDirectory: false, size: 4100 },
    { name: "styles.css", isDirectory: false, size: 300 },
  ],
  [`${ROOT}/docs`]: [{ name: "guide.md", isDirectory: false, size: 2200 }],
};

function listDirectory(args: unknown): unknown {
  const dirPath = (args as { dirPath?: string } | undefined)?.dirPath ?? "";
  return (
    LISTINGS[dirPath] ?? hostResponses.permissionRequired(`${dirPath} is outside the worktree`)
  );
}

export default {
  title: "Sample / File tree",
  component: FileTreeView,
  args: { pluginId: "daintree.sample-file-tree", panelId: "file-tree-1" },
  fixtures: {
    channels: {
      root: { path: ROOT },
      "list-directory": listDirectory,
    },
  },
} satisfies PanelStoriesMeta;

/** A panel opened with no worktree behind it. */
export const Empty: PanelStory = {
  fixtures: { channels: { root: { path: null } } },
};

/** The root listing has not come back yet. */
export const Loading: PanelStory = {
  fixtures: { channels: { "list-directory": hostResponses.pending() } },
};

/** A restored panel: `src` expanded and a file selected, as it was left. */
export const Populated: PanelStory = {
  args: { initialArgs: { expanded: ["src"], selected: "src/panel.tsx" } },
};

/** A directory the host refused to list, marked on its row. */
export const UnreadableDirectory: PanelStory = {
  fixtures: {
    channels: {
      "list-directory": (args: unknown) =>
        (args as { dirPath?: string }).dirPath === `${ROOT}/docs`
          ? hostResponses.permissionRequired("fs:project-read was not granted")
          : listDirectory(args),
    },
  },
  args: { initialArgs: { expanded: ["docs"] } },
};

/** The window is attached to a host whose link is down. */
export const Disconnected: PanelStory = {
  fixtures: { channels: { root: hostResponses.disconnected() } },
};

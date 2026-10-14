import { PREVIEW_FAILURE_ATTRIBUTE, PREVIEW_READY_ATTRIBUTE } from "../preview/attributes.js";

/** Where the page publishes its stories, and the mounted preview once it has one. */
export const PREVIEW_HANDLE = "__daintreePanelPreview";

export const SCRIPT_PATH = "/_preview/panel.js";
export const PANEL_CSS_PATH = "/_preview/panel.css";
/** The SDK's `browser/` directory: `preview.css` and the fonts and images it points at. */
export const KIT_PATH = "/_preview/kit/";

/** Marks a stylesheet the page's readiness waits on. */
const STYLE_ATTRIBUTE = "data-preview-style";

function stylesheet(href: string): string {
  // Inline handlers, so a sheet that settled before the harness ran is still
  // known to have loaded or failed.
  return `<link rel="stylesheet" href="${href}" ${STYLE_ATTRIBUTE} onload="this.dataset.state='loaded'" onerror="this.dataset.state='failed'" />`;
}

/**
 * The page: the kit's host stylesheet, the plugin's compiled utilities, and the
 * bundled harness. The panel fills the viewport, so the test's viewport is the
 * panel size and a screenshot of the page is a screenshot of the panel.
 */
export function renderShell(title: string): string {
  const escaped = title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escaped} — panel preview</title>
    ${stylesheet(`${KIT_PATH}preview.css`)}
    ${stylesheet(PANEL_CSS_PATH)}
    <style>
      html, body { margin: 0; height: 100%; }
      body { background: var(--color-surface-canvas); }
      #root { position: fixed; inset: 0; background: var(--color-surface-panel); }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${SCRIPT_PATH}"></script>
  </body>
</html>
`;
}

/**
 * The harness module, bundled with the plugin's stories. Without a `story`
 * query it only publishes the stories' export names; with one it mounts that
 * story under `theme` and the page reports readiness on its root.
 */
export function renderHarness(storiesFile: string): string {
  return `import * as stories from ${JSON.stringify(storiesFile)};
import { listPanelStories, mountPanelStory } from "@daintreehq/plugin-sdk/testing/preview";
import { whenPluginUiReady } from "@daintreehq/plugin-ui";

const root = document.documentElement;
const handle = (window[${JSON.stringify(PREVIEW_HANDLE)}] = {});

function fail(reason) {
  root.setAttribute(${JSON.stringify(PREVIEW_READY_ATTRIBUTE)}, "failed");
  root.setAttribute(${JSON.stringify(PREVIEW_FAILURE_ATTRIBUTE)}, reason);
}

function stylesheets() {
  let failure = null;
  const listeners = new Set();
  const settle = (link) =>
    new Promise((resolve) => {
      const done = () => {
        if (link.dataset.state === "failed") {
          failure ??= \`\${link.getAttribute("href")} did not load\`;
          for (const listener of [...listeners]) listener();
        }
        resolve();
      };
      if (link.dataset.state) return done();
      link.addEventListener("load", () => queueMicrotask(done), { once: true });
      link.addEventListener("error", () => queueMicrotask(done), { once: true });
    });
  const settled = Promise.all([...document.querySelectorAll("link[${STYLE_ATTRIBUTE}]")].map(settle));
  return {
    registerRoot: () => () => {},
    settled: () => settled.then(() => {}),
    failure: () => failure,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

try {
  if (!stories.default || typeof stories.default.component !== "function") {
    throw new Error("the stories file has no default export with a \`component\`");
  }
  const listed = listPanelStories(stories);
  handle.stories = listed.map((story) => story.exportName);
  const params = new URLSearchParams(window.location.search);
  const name = params.get("story");
  if (name !== null) {
    const selected = listed.find((story) => story.exportName === name);
    if (!selected) throw new Error(\`no story "\${name}"; known: \${handle.stories.join(", ")}\`);
    handle.preview = mountPanelStory(stories.default, selected.story, {
      container: document.getElementById("root"),
      theme: params.get("theme") ?? undefined,
      styles: stylesheets(),
      kit: { ready: whenPluginUiReady() },
    });
  }
} catch (error) {
  handle.error = error instanceof Error ? error.message : String(error);
  fail(\`preview did not start: \${handle.error}\`);
}
`;
}

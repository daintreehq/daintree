import { CONFIG_ELEMENT_ID, type TourPreviewConfig } from "./protocol.js";

export const STYLES_PATH = "/_preview/styles.css";
export const HARNESS_PATH = "/_preview/harness/harness.js";

/** JSON that is safe inside a `<script>` element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The page: an import map for the React and tour specifiers the host serves (so
 * a scene importing anything else fails here as it would in Daintree), the
 * compiled stylesheet, the tour config, and the harness.
 */
export function renderShell(
  config: TourPreviewConfig,
  imports: Record<string, string>,
  themeType: "dark" | "light"
): string {
  return `<!doctype html>
<html lang="en" class="${themeType}" data-color-mode="${themeType}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(config.title)} — tour preview</title>
    <script type="importmap">${scriptJson({ imports })}</script>
    <link rel="stylesheet" href="${STYLES_PATH}" />
    <script type="application/json" id="${CONFIG_ELEMENT_ID}">${scriptJson(config)}</script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${HARNESS_PATH}"></script>
  </body>
</html>
`;
}

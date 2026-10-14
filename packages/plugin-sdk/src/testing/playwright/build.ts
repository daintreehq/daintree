import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "esbuild";
import { renderHarness } from "./page.js";
import { loadOptionalPeer } from "./peers.js";
import { collectCandidates, compilePanelCss } from "./styles.js";

export interface PanelPreviewBuildOptions {
  /** The plugin's directory: where its stories and its dependencies resolve from. */
  pluginDir: string;
  /** The stories module, relative to `pluginDir`. */
  storiesPath: string;
}

export interface PanelPreviewBuild {
  /** The harness, the stories and everything they import, as one module. */
  script: string;
  /** The plugin's compiled utilities, plus any CSS its modules import. */
  css: string;
  /** The SDK's `browser/` directory, served for `preview.css` and its assets. */
  kitDir: string;
  /** The class candidates `css` was compiled for. */
  candidates: string[];
}

const REACT_SPECIFIER = /^react(-dom)?(\/.*)?$/;
const SDK_SPECIFIER = /^@daintreehq\/plugin-sdk(\/.*)?$/;
const KIT_SPECIFIER = /^@daintreehq\/plugin-ui$/;
/** The browser build of the host's kit, which a page outside Daintree uses instead. */
const TESTING_KIT = "@daintreehq/plugin-sdk/testing/plugin-ui";
/** The harness's name in the build, which reads it from stdin. */
const HARNESS_FILE = "panel-preview-harness.js";

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Bundle the stories with the harness. React, ReactDOM and the SDK are pinned
 * to the plugin's own installed copies, and the host-served
 * `@daintreehq/plugin-ui` to the SDK's browser build of it, so the stories, the
 * preview and the kit share one React without an import map.
 */
export async function buildPanelPreview(
  opts: PanelPreviewBuildOptions
): Promise<PanelPreviewBuild> {
  const pluginDir = await fs.realpath(opts.pluginDir);
  const storiesFile = path.resolve(pluginDir, opts.storiesPath);
  try {
    await fs.access(storiesFile);
  } catch {
    throw new Error(`No stories module at ${storiesFile}; write one, or point storiesPath at it`);
  }
  const requireFromPlugin = createRequire(path.join(pluginDir, "package.json"));
  const resolveFromPlugin = (specifier: string): string => {
    try {
      return requireFromPlugin.resolve(specifier);
    } catch (error) {
      throw new Error(
        `Couldn't resolve "${specifier}" from ${pluginDir}; the panel preview renders against the plugin's own installed copy`,
        { cause: error }
      );
    }
  };

  let kitStylesheet: string;
  try {
    kitStylesheet = requireFromPlugin.resolve("@daintreehq/plugin-sdk/testing/preview.css");
    await fs.access(kitStylesheet);
  } catch (error) {
    throw new Error(
      `The installed @daintreehq/plugin-sdk has no browser build (testing/preview.css); a published SDK ships one, and a source checkout builds it with \`npm run build:browser\` in packages/plugin-sdk`,
      { cause: error }
    );
  }

  const pinned: Plugin = {
    name: "panel-preview-pinned",
    setup(build) {
      build.onResolve({ filter: REACT_SPECIFIER }, (args) => ({
        path: resolveFromPlugin(args.path),
      }));
      build.onResolve({ filter: SDK_SPECIFIER }, (args) => ({
        path: resolveFromPlugin(args.path),
      }));
      build.onResolve({ filter: KIT_SPECIFIER }, () => ({ path: resolveFromPlugin(TESTING_KIT) }));
    },
  };

  const esbuild = await loadOptionalPeer<typeof import("esbuild")>(
    "esbuild",
    () => import("esbuild")
  );
  // Nothing is written; esbuild only needs somewhere to name the outputs.
  const outdir = path.join(pluginDir, ".panel-preview");
  let result;
  try {
    result = await esbuild.build({
      absWorkingDir: pluginDir,
      stdin: {
        contents: renderHarness(storiesFile),
        resolveDir: pluginDir,
        sourcefile: HARNESS_FILE,
        loader: "js",
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      outdir,
      entryNames: "panel",
      // The build Daintree ships: React's production build logs no development
      // warnings, so a console error is the panel's own.
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      loader: {
        ".png": "dataurl",
        ".jpg": "dataurl",
        ".jpeg": "dataurl",
        ".gif": "dataurl",
        ".webp": "dataurl",
        ".svg": "dataurl",
        ".woff2": "dataurl",
      },
      write: false,
      metafile: true,
      logLevel: "silent",
      plugins: [pinned],
    });
  } catch (error) {
    const errors = (error as { errors?: Array<{ text: string }> }).errors;
    const detail = errors?.map((e) => e.text).join("\n") ?? (error as Error).message;
    throw new Error(`Couldn't bundle ${opts.storiesPath} for the panel preview:\n${detail}`, {
      cause: error,
    });
  }

  const script = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text ?? "";
  const importedCss = result.outputFiles
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => file.text);

  // Classes come from the plugin's own modules, never its dependencies: the
  // kit's are already in preview.css, and a vendor bundle is all noise.
  const sources: string[] = [];
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input === HARNESS_FILE || input === "<stdin>") continue;
    const file = path.resolve(pluginDir, input);
    if (!isInside(pluginDir, file) || file.split(path.sep).includes("node_modules")) continue;
    sources.push(await fs.readFile(file, "utf8"));
  }
  const candidates = collectCandidates(sources);
  const css = [await compilePanelCss(candidates), ...importedCss].join("\n");
  return { script, css, kitDir: path.dirname(kitStylesheet), candidates };
}

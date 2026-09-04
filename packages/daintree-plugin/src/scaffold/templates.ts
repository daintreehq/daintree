/**
 * Starter templates for `daintree-plugin new`. Each template returns a map of
 * POSIX-relative path → file content. Content is embedded as strings so the
 * published CLI is self-contained (no `templates/` directory to ship). The
 * reference for the host API surface is `plugins/sample/hello-daintree/`.
 */

import { safeRecipeFilename } from "../../../../shared/utils/recipeFilename.js";

export type TemplateKind = "command" | "view" | "mcp" | "full";

export const TEMPLATE_KINDS: readonly TemplateKind[] = ["command", "view", "mcp", "full"] as const;

export interface ScaffoldContext {
  /** Full scoped manifest name, e.g. `acme.issue-helper`. */
  scopedName: string;
  /** Publisher segment, e.g. `acme`. */
  publisher: string;
  /** Plugin segment, e.g. `issue-helper`. */
  pluginName: string;
  /** Human-facing display name. */
  displayName: string;
  template: TemplateKind;
  /**
   * Project-local plugin: lives at `<projectRoot>/.daintree/plugins/<name>/`,
   * is committed to the project's repo, and loads only while that project is
   * open. Changes what the same template emits rather than adding a template:
   * `scope: "project"` in the manifest, a `dev` watcher script, inline source
   * maps, and a `.gitignore` that force-includes `dist/`. See
   * {@link buildProjectRecipe} for the watcher recipe that ships alongside.
   */
  projectLocal?: boolean;
}

/** Directory a project-local plugin is scaffolded into, relative to the project root. */
export function projectPluginRelDir(scopedName: string): string {
  return `.daintree/plugins/${scopedName}`;
}

// Open-ended lower bound: `^0.11.0` resolves to `>=0.11.0 <0.12.0` under semver's
// 0.x caret rule, so a scaffolded plugin would be rejected by the host's
// `engines.daintree` gate on every release past 0.11 (e.g. 0.19.x). Match the
// reference manifests under `plugins/sample/`, which pin the open-ended range.
const DAINTREE_ENGINE_RANGE = ">=0.11.0";

/**
 * A `contributes.panels` entry paired with a `views` entry of the
 * same `id`. The runtime (`PluginService.loadPlugin`) only registers a panel
 * kind while iterating declared `panels`, attaching the view's `componentPath`
 * when ids match; a view with no matching panel is ignored, so the scaffold
 * must emit both for a generated view to render. `iconId: "puzzle"` and the
 * plugin brand color are the canonical defaults for plugin-contributed panels.
 */
function viewPanelContribution(ctx: ScaffoldContext): Record<string, unknown> {
  return {
    id: "main",
    name: ctx.displayName,
    iconId: "puzzle",
    color: "var(--theme-category-orange)",
  };
}

/** A safely-quoted JS/TS string literal for embedding author text in source. */
function q(value: string): string {
  return JSON.stringify(value);
}

/** Single-line, comment-safe rendering of author text: strips newlines and any
 * block-comment terminator so it can't break the generated JSDoc. */
function c(value: string): string {
  return value.replace(/\*\//g, "* /").replace(/[\r\n]+/g, " ");
}

/**
 * Where the generated JSON Schema for `plugin.json` is published. Stamping it
 * into the scaffold is the point of generating it: an editor pointed at this
 * URL flags a misspelled field as the author types it, which is the class of
 * mistake that otherwise surfaces as a plugin that silently never loads.
 * Structural rules only — the cross-field rules live in the host.
 */
const MANIFEST_SCHEMA_BASE_URL =
  "https://raw.githubusercontent.com/daintreehq/daintree/develop/schemas";

function manifest(ctx: ScaffoldContext, contributes: Record<string, unknown>): string {
  const obj = {
    $schema: `${MANIFEST_SCHEMA_BASE_URL}/${ctx.projectLocal ? "plugin.project.schema.json" : "plugin.schema.json"}`,
    name: ctx.scopedName,
    version: "0.1.0",
    // Marks the plugin as project-local. Omitted entirely for an installed
    // plugin so existing manifests are byte-identical to what they were.
    ...(ctx.projectLocal ? { scope: "project" } : {}),
    displayName: ctx.displayName,
    description: `${ctx.displayName} — a Daintree plugin.`,
    main: "dist/index.js",
    engines: { daintree: DAINTREE_ENGINE_RANGE },
    capabilities: [] as string[],
    contributes,
  };
  return JSON.stringify(obj, null, 2) + "\n";
}

function packageJson(ctx: ScaffoldContext, needsReact: boolean, needsServer = false): string {
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {
    "@daintreehq/plugin-sdk": "^0.1.0",
    "@daintreehq/plugin-vite": "^0.1.0",
    typescript: "^5.6.0",
    vite: "^8.0.0",
  };
  if (needsReact) {
    devDeps.react = "^19.0.0";
    devDeps["react-dom"] = "^19.0.0";
    // React 19 still ships types separately; without these the generated
    // `panel.tsx` fails `tsc` on the `react` import and the JSX namespace.
    devDeps["@types/react"] = "^19.0.0";
    devDeps["@types/react-dom"] = "^19.0.0";
  }
  if (needsServer) {
    // Runtime dependency, not a devDependency: the spawned `node dist/server.js`
    // imports the SDK at runtime, so it must be installed in the packaged plugin.
    // Floor at 1.12: `server/mcp.js`'s `McpServer` arrived in 1.3 and
    // `registerTool` (used by the generated server) in 1.12, so a lower `^1.0.0`
    // could resolve to a release missing both.
    deps["@modelcontextprotocol/sdk"] = "^1.12.0";
  }
  if (ctx.projectLocal) {
    // The project-local vite.config.ts imports `node:path` to absolutize
    // sourcemap `sources`. The config file is outside tsconfig's `include`, so
    // this is for the editor rather than `tsc`, but a missing type here reads
    // as a broken scaffold.
    devDeps["@types/node"] = "^22.13.0";
  }
  const scripts: Record<string, string> = {
    // `vite build` runs one config object at a time, so the Node server entry
    // is built by a second pass against vite.config.server.ts (see that file).
    build: needsServer ? "vite build && vite build --config vite.config.server.ts" : "vite build",
  };
  if (ctx.projectLocal) {
    // The authoring loop for a project plugin: rebuild dist/ in place on save.
    // `daintree-plugin dev` is the installed-plugin loop (package + push into a
    // running Daintree); a project plugin is already where the host reads it.
    //
    // Two watchers share one dist/, and Vite re-empties outDir on *every*
    // incremental rebuild, so each browser save would delete the server bundle.
    // `--no-emptyOutDir` on both is the same fix `resolveVitePlan` applies to
    // `daintree-plugin dev` (see lib/viteBuild.ts) — and, as there, it is only
    // worth its cost (stale output lingering) in dual-config mode.
    scripts.dev = needsServer ? "vite build --watch --no-emptyOutDir" : "vite build --watch";
    if (needsServer) {
      scripts["dev:server"] = "vite build --watch --config vite.config.server.ts --no-emptyOutDir";
    }
  }
  scripts.validate = "daintree-plugin validate";
  if (!ctx.projectLocal) {
    // A project plugin is distributed by being committed, not as a .dntr.
    scripts.package = "daintree-plugin package";
  }
  const obj = {
    name: ctx.scopedName,
    version: "0.1.0",
    description: `${ctx.displayName} — a Daintree plugin.`,
    type: "module",
    private: true,
    scripts,
    dependencies: deps,
    devDependencies: devDeps,
  };
  return JSON.stringify(obj, null, 2) + "\n";
}

function tsconfig(jsx: boolean): string {
  const compilerOptions: Record<string, unknown> = {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    lib: jsx ? ["ES2022", "DOM", "DOM.Iterable"] : ["ES2022"],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    isolatedModules: true,
    esModuleInterop: true,
  };
  if (jsx) compilerOptions.jsx = "react-jsx";
  return JSON.stringify({ compilerOptions, include: ["src"] }, null, 2) + "\n";
}

/**
 * Sourcemap settings for a project-local build. Installed plugins keep sidecar
 * `.map` files (`daintree-plugin package --sourcemaps` decides whether they
 * ship). A project plugin loads straight out of the repo, so a sidecar would
 * have to be fetched over the `plugin://` protocol — inlining the map avoids
 * that route entirely, and absolutizing `sources` puts DevTools breakpoints in
 * the real on-disk `.tsx` rather than a path relative to a map that isn't there.
 */
const PROJECT_SOURCEMAP_BLOCK = `    sourcemap: "inline",
    rollupOptions: {
      output: {
        sourcemapPathTransform: (relativeSourcePath, sourcemapPath) =>
          path.resolve(path.dirname(sourcemapPath), relativeSourcePath),
      },
    },`;

const INSTALLED_SOURCEMAP_BLOCK = `    sourcemap: true,`;

function sourcemapBlock(ctx: ScaffoldContext): string {
  return ctx.projectLocal ? PROJECT_SOURCEMAP_BLOCK : INSTALLED_SOURCEMAP_BLOCK;
}

function nodePathImport(ctx: ScaffoldContext): string {
  return ctx.projectLocal ? 'import path from "node:path";\n' : "";
}

function viteConfig(ctx: ScaffoldContext, entries: Record<string, string>): string {
  // `entry:` sits at 6-space depth inside the `build.lib` block, so each line of
  // the embedded object literal needs a 6-space lead to align — and the closing
  // brace must land back at that depth. Stringify at 2-space indent, then offset
  // every line by the 6 spaces of the surrounding context.
  const entryLiteral = JSON.stringify(entries, null, 2).replace(/\n/g, "\n      ");
  return `${nodePathImport(ctx)}import { daintreePlugin } from "@daintreehq/plugin-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [daintreePlugin()],
  build: {
    lib: {
      entry: ${entryLiteral},
      formats: ["es"],
    },
    outDir: "dist",
${sourcemapBlock(ctx)}
  },
});
`;
}

/**
 * Vite config for Node entries (stdio MCP servers). Separate from the browser
 * config because a single \`vite build\` runs one config object at a time, and a
 * Node target must not be applied to the renderer/panel bundles. \`target:
 * "node"\` externalizes Node built-ins instead of browser-shimming them — the
 * root cause of a stdio server crashing with \`process.stdin === undefined\`.
 * \`emptyOutDir: false\` preserves the browser build that ran first.
 */
function viteServerConfig(ctx: ScaffoldContext, entries: Record<string, string>): string {
  // Same 6-space alignment as viteConfig (see the note there).
  const entryLiteral = JSON.stringify(entries, null, 2).replace(/\n/g, "\n      ");
  return `${nodePathImport(ctx)}import { daintreePlugin } from "@daintreehq/plugin-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [daintreePlugin({ target: "node" })],
  build: {
    lib: {
      entry: ${entryLiteral},
      formats: ["es"],
    },
    outDir: "dist",
    emptyOutDir: false,
${sourcemapBlock(ctx)}
  },
});
`;
}

const GITIGNORE = `node_modules/
dist/
*.dntr
.dev-marker
`;

/**
 * The project-local `.gitignore`. `dist/` is not merely absent — it is
 * force-included, because most repositories ignore `dist/` at their root and a
 * root pattern would otherwise swallow this directory too. A deeper
 * `.gitignore` wins over a shallower one for the same path, so the negation is
 * what actually keeps the build output tracked.
 *
 * This is the load contract: Daintree reads `plugin.json` and `dist/`, never
 * `src/`, and never runs the build. An untracked `dist/` is a plugin that
 * silently fails to load on every other checkout.
 */
const PROJECT_GITIGNORE = `node_modules/
*.dntr
.dev-marker

# dist/ is deliberately NOT ignored, and is force-included below.
#
# Daintree loads this plugin from its committed dist/. The host never compiles
# it, never reads src/, and never runs package.json — so a checkout without
# dist/ is a plugin that cannot load, on any machine or branch.
#
# The negations matter: most repos ignore \`dist/\` at the root, and that pattern
# would cover this directory too. A deeper .gitignore wins, so these two lines
# are what keep the build output tracked. Do not remove them.
#
# Both are needed. \`!dist/\` re-includes the directory so git descends into it at
# all; \`!dist/**\` re-includes the files, which a parent rule matching contents
# (\`dist/*\`, \`**/dist/**\`, even \`*.js\`) would otherwise still exclude.
#
# The one case no rule here can fix: if the project ignores \`.daintree/\` itself,
# git never descends far enough to read this file. Un-ignore it at the project
# root instead.
!dist/
!dist/**
`;

function projectReadme(ctx: ScaffoldContext, recipeName: string): string {
  const dir = projectPluginRelDir(ctx.scopedName);
  const hasServer = ctx.template === "mcp" || ctx.template === "full";
  const devLine = hasServer
    ? "npm run dev        # rebuilds dist/ on save\nnpm run dev:server # second watcher for the MCP server entry"
    : "npm run dev        # rebuilds dist/ on save";
  return `# ${ctx.displayName}

A project-local Daintree plugin. It lives in this repository at \`${dir}/\` and
loads only while this project is open in Daintree.

## The committed \`dist/\` is the load contract

Daintree reads \`plugin.json\` and the files under \`dist/\`. It never compiles
this plugin, never reads \`src/\`, and never runs \`package.json\`.

So \`dist/\` is committed, and \`.gitignore\` force-includes it. If \`dist/\` is
missing or stale on a branch, the plugin is missing or stale for anyone who
checks that branch out — including an agent working in a fresh worktree. Rebuild
and commit \`dist/\` in the same commit as the source change that caused it.

## Authoring loop

\`\`\`bash
cd ${dir}
npm install
${devLine}
\`\`\`

The **${recipeName}** recipe in \`.daintree/recipes/\` starts the same watcher, so
Daintree can bring it up alongside the rest of the project environment.
`;
}

// Ships commented-out so a fresh plugin excludes nothing extra — it exists to
// make the mechanism discoverable, since `.gitignore` alone can't express
// "tracked in the repo, but not shipped to users".
const DNTRIGNORE = `# Files to keep OUT of the packaged .dntr, in .gitignore syntax.
# Applies on top of .gitignore, and unlike .gitignore it also applies inside
# dist/ — so build output you don't want to distribute can be excluded here.
# Run \`daintree-plugin package --dry-run\` to audit the resulting file list.

# docs/
# screenshots/
# dist/*.stats.html
`;

function commandEntry(ctx: ScaffoldContext): string {
  const title = q(`${ctx.displayName}: Run`);
  const description = q(`Run the ${ctx.displayName} command.`);
  const category = q(ctx.displayName);
  const message = q(`Hello from ${ctx.displayName}`);
  return `import type { PluginHostApi } from "@daintreehq/plugin-sdk";

/**
 * ${c(ctx.displayName)} — command plugin entry. Daintree calls \`activate\` once
 * when the plugin loads; return a disposer to clean up on unload. Actions are
 * unregistered automatically on unload, so the disposer here is a no-op.
 */
export async function activate(host: PluginHostApi): Promise<() => void> {
  await host.registerAction(
    {
      id: "run",
      title: ${title},
      description: ${description},
      category: ${category},
      kind: "command",
      danger: "safe",
    },
    async () => {
      await host.showToast({ message: ${message}, type: "success" });
      return { ran: true };
    }
  );

  return () => {};
}
`;
}

function viewEntry(ctx: ScaffoldContext): string {
  return `import type { PluginHostApi } from "@daintreehq/plugin-sdk";

/**
 * ${c(ctx.displayName)} — view plugin entry. The panel UI lives in \`src/panel.tsx\`
 * and is wired through \`contributes.views\` in plugin.json.
 */
export async function activate(_host: PluginHostApi): Promise<() => void> {
  return () => {};
}
`;
}

function panelComponent(ctx: ScaffoldContext): string {
  return `import React from "react";

/**
 * Panel view for ${c(ctx.displayName)}. Rendered by Daintree when the user opens
 * the contributed view.
 */
export default function Panel(): React.ReactElement {
  return <div style={{ padding: 16 }}>{${q(`Hello from ${ctx.displayName}`)}}</div>;
}
`;
}

function mcpEntry(ctx: ScaffoldContext): string {
  return `import type { PluginHostApi } from "@daintreehq/plugin-sdk";

/**
 * ${c(ctx.displayName)} — MCP plugin entry. The MCP server process is declared in
 * \`contributes.mcpServers\` (see plugin.json) and spawned by
 * Daintree; \`src/server.ts\` is its skeleton implementation.
 */
export async function activate(_host: PluginHostApi): Promise<() => void> {
  return () => {};
}
`;
}

function mcpServer(ctx: ScaffoldContext): string {
  return `#!/usr/bin/env node
/**
 * Minimal stdio MCP server for ${c(ctx.displayName)}. Daintree spawns it per the
 * \`command\`/\`args\` in plugin.json and speaks MCP over stdio. The SDK answers
 * the \`initialize\` handshake and \`tools/list\` automatically once connected —
 * the previous skeleton only listened on stdin and never replied, so the host
 * timed out and marked the server crashed.
 *
 * Never write to stdout yourself: it carries the JSON-RPC stream and stray
 * output corrupts the protocol. Log to stderr (\`console.error\`) instead. Built
 * with vite.config.server.ts (\`target: "node"\`) so the SDK's stdio transport
 * gets the real Node \`process\` rather than a browser shim.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: ${q(ctx.scopedName)}, version: "0.1.0" });

// Example tool — replace with your own. It takes no input and returns text;
// add an \`inputSchema\` (a Zod raw shape) to accept arguments.
server.registerTool(
  "ping",
  { description: ${q(`Health check for ${ctx.displayName}; replies with "pong".`)} },
  async () => ({ content: [{ type: "text", text: "pong" }] })
);

await server.connect(new StdioServerTransport());
`;
}

/**
 * The starter files for a plugin project, keyed by POSIX-relative path.
 *
 * A project-local plugin is a variation on the same templates rather than a
 * parallel set: the switch below is shared, and {@link projectVariant} swaps the
 * few files whose contract differs (the `.gitignore` that must keep `dist/`
 * tracked, the packaging-only `.dntrignore` that no longer applies, and a README
 * explaining the committed-`dist/` contract).
 */
export function buildTemplateFiles(ctx: ScaffoldContext): Record<string, string> {
  const files = templateFiles(ctx);
  return ctx.projectLocal ? projectVariant(ctx, files) : files;
}

function projectVariant(
  ctx: ScaffoldContext,
  files: Record<string, string>
): Record<string, string> {
  const next = { ...files };
  next[".gitignore"] = PROJECT_GITIGNORE;
  // `.dntrignore` only shapes a `.dntr` archive, and a project plugin is never
  // packaged into one.
  delete next[".dntrignore"];
  next["README.md"] = projectReadme(ctx, projectRecipeName(ctx.scopedName));
  return next;
}

function templateFiles(ctx: ScaffoldContext): Record<string, string> {
  switch (ctx.template) {
    case "command": {
      return {
        "plugin.json": manifest(ctx, {
          commands: [
            {
              id: "run",
              title: `${ctx.displayName}: Run`,
              description: `Run the ${ctx.displayName} command.`,
              category: ctx.displayName,
              kind: "command",
              danger: "safe",
              keywords: [ctx.pluginName, "run"],
            },
          ],
        }),
        "package.json": packageJson(ctx, false),
        "tsconfig.json": tsconfig(false),
        "vite.config.ts": viteConfig(ctx, { index: "src/index.ts" }),
        ".gitignore": GITIGNORE,
        ".dntrignore": DNTRIGNORE,
        "src/index.ts": commandEntry(ctx),
      };
    }
    case "view": {
      return {
        "plugin.json": manifest(ctx, {
          panels: [viewPanelContribution(ctx)],
          views: [
            {
              id: "main",
              componentPath: "dist/panel.js",
              location: "panel",
            },
          ],
        }),
        "package.json": packageJson(ctx, true),
        "tsconfig.json": tsconfig(true),
        "vite.config.ts": viteConfig(ctx, { index: "src/index.ts", panel: "src/panel.tsx" }),
        ".gitignore": GITIGNORE,
        ".dntrignore": DNTRIGNORE,
        "src/index.ts": viewEntry(ctx),
        "src/panel.tsx": panelComponent(ctx),
      };
    }
    case "mcp": {
      return {
        "plugin.json": manifest(ctx, {
          mcpServers: [
            {
              id: "main",
              name: ctx.displayName,
              command: "node",
              args: ["dist/server.js"],
            },
          ],
        }),
        "package.json": packageJson(ctx, false, true),
        "tsconfig.json": tsconfig(false),
        "vite.config.ts": viteConfig(ctx, { index: "src/index.ts" }),
        "vite.config.server.ts": viteServerConfig(ctx, { server: "src/server.ts" }),
        ".gitignore": GITIGNORE,
        ".dntrignore": DNTRIGNORE,
        "src/index.ts": mcpEntry(ctx),
        "src/server.ts": mcpServer(ctx),
      };
    }
    case "full": {
      return {
        "plugin.json": manifest(ctx, {
          commands: [
            {
              id: "run",
              title: `${ctx.displayName}: Run`,
              description: `Run the ${ctx.displayName} command.`,
              category: ctx.displayName,
              kind: "command",
              danger: "safe",
              keywords: [ctx.pluginName, "run"],
            },
          ],
          panels: [viewPanelContribution(ctx)],
          views: [
            {
              id: "main",
              componentPath: "dist/panel.js",
              location: "panel",
            },
          ],
          mcpServers: [
            {
              id: "main",
              name: ctx.displayName,
              command: "node",
              args: ["dist/server.js"],
            },
          ],
        }),
        "package.json": packageJson(ctx, true, true),
        "tsconfig.json": tsconfig(true),
        "vite.config.ts": viteConfig(ctx, {
          index: "src/index.ts",
          panel: "src/panel.tsx",
        }),
        "vite.config.server.ts": viteServerConfig(ctx, { server: "src/server.ts" }),
        ".gitignore": GITIGNORE,
        ".dntrignore": DNTRIGNORE,
        "src/index.ts": commandEntry(ctx),
        "src/panel.tsx": panelComponent(ctx),
        "src/server.ts": mcpServer(ctx),
      };
    }
  }
}

/**
 * The `.daintree/recipes/` entry that starts a project plugin's build watcher.
 * Recipes are tracked in the project's repo, so committing this makes the
 * authoring loop available to anyone who opens the project — the recipe brings
 * the environment up, and the plugin is part of that environment.
 *
 * Shaped to clear `sanitizeRecipeTerminals` at the in-repo trust boundary:
 * `type: "terminal"` is an always-allowed kind, the commands carry no control
 * characters (the scoped name is `[a-z0-9-]` segments joined by a dot), and the
 * terminal count is 2 at most — well inside `MAX_TERMINALS_PER_RECIPE` (10).
 * The commands are typed into an interactive shell rooted at the worktree, so
 * they `cd` into the plugin directory first.
 */
export interface ProjectRecipe {
  /** Recipe display name, also the basis for the filename and id. */
  name: string;
  /** Path relative to the project root, POSIX separators. */
  relPath: string;
  content: string;
}

export function projectRecipeName(scopedName: string): string {
  return `${scopedName} watch`;
}

export interface ProjectRecipeOptions {
  /**
   * Opaque recipe id. In-repo recipes moved off name-derived ids (#9195) so a
   * rename cannot change a recipe's identity — a caller passes a UUID.
   */
  id: string;
  createdAt: number;
}

/**
 * Author text is not validated on the interactive prompt, and terminal `title`
 * is one field `sanitizeRecipeTerminals` passes through untouched. Strip C0
 * characters here so a pasted display name cannot put them in a committed
 * recipe.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function recipeTitle(displayName: string, suffix: string): string {
  return `${displayName.replace(CONTROL_CHARS, "")} ${suffix}`;
}

export function buildProjectRecipe(
  ctx: ScaffoldContext,
  options: ProjectRecipeOptions
): ProjectRecipe {
  const dir = projectPluginRelDir(ctx.scopedName);
  const name = projectRecipeName(ctx.scopedName);
  const filename = safeRecipeFilename(name);
  const terminals: Array<Record<string, unknown>> = [
    {
      type: "terminal",
      title: recipeTitle(ctx.displayName, "build"),
      command: `cd ${dir} && npm run dev`,
      env: {},
    },
  ];
  if (ctx.template === "mcp" || ctx.template === "full") {
    // `vite build --watch` runs one config object at a time, so the Node server
    // entry needs its own watcher rather than a chained command.
    terminals.push({
      type: "terminal",
      title: recipeTitle(ctx.displayName, "server build"),
      command: `cd ${dir} && npm run dev:server`,
      env: {},
    });
  }
  const recipe = {
    id: options.id,
    name,
    terminals,
    createdAt: options.createdAt,
    showInEmptyState: true,
  };
  return {
    name,
    relPath: `.daintree/recipes/${filename}`,
    content: JSON.stringify(recipe, null, 2) + "\n",
  };
}

/**
 * Starter templates for `daintree-plugin new`. Each template returns a map of
 * POSIX-relative path → file content. Content is embedded as strings so the
 * published CLI is self-contained (no `templates/` directory to ship). The
 * reference for the host API surface is `plugins/sample/hello-daintree/`.
 */

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

function manifest(ctx: ScaffoldContext, contributes: Record<string, unknown>): string {
  const obj = {
    name: ctx.scopedName,
    version: "0.1.0",
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
  const obj = {
    name: ctx.scopedName,
    version: "0.1.0",
    description: `${ctx.displayName} — a Daintree plugin.`,
    type: "module",
    private: true,
    scripts: {
      // `vite build` runs one config object at a time, so the Node server entry
      // is built by a second pass against vite.config.server.ts (see that file).
      build: needsServer ? "vite build && vite build --config vite.config.server.ts" : "vite build",
      validate: "daintree-plugin validate",
      package: "daintree-plugin package",
    },
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

function viteConfig(entries: Record<string, string>): string {
  // `entry:` sits at 6-space depth inside the `build.lib` block, so each line of
  // the embedded object literal needs a 6-space lead to align — and the closing
  // brace must land back at that depth. Stringify at 2-space indent, then offset
  // every line by the 6 spaces of the surrounding context.
  const entryLiteral = JSON.stringify(entries, null, 2).replace(/\n/g, "\n      ");
  return `import { daintreePlugin } from "@daintreehq/plugin-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [daintreePlugin()],
  build: {
    lib: {
      entry: ${entryLiteral},
      formats: ["es"],
    },
    outDir: "dist",
    sourcemap: true,
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
function viteServerConfig(entries: Record<string, string>): string {
  // Same 6-space alignment as viteConfig (see the note there).
  const entryLiteral = JSON.stringify(entries, null, 2).replace(/\n/g, "\n      ");
  return `import { daintreePlugin } from "@daintreehq/plugin-vite";
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
    sourcemap: true,
  },
});
`;
}

const GITIGNORE = `node_modules/
dist/
*.dntr
.dev-marker
`;

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

export function buildTemplateFiles(ctx: ScaffoldContext): Record<string, string> {
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
        "vite.config.ts": viteConfig({ index: "src/index.ts" }),
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
        "vite.config.ts": viteConfig({ index: "src/index.ts", panel: "src/panel.tsx" }),
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
        "vite.config.ts": viteConfig({ index: "src/index.ts" }),
        "vite.config.server.ts": viteServerConfig({ server: "src/server.ts" }),
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
        "vite.config.ts": viteConfig({
          index: "src/index.ts",
          panel: "src/panel.tsx",
        }),
        "vite.config.server.ts": viteServerConfig({ server: "src/server.ts" }),
        ".gitignore": GITIGNORE,
        ".dntrignore": DNTRIGNORE,
        "src/index.ts": commandEntry(ctx),
        "src/panel.tsx": panelComponent(ctx),
        "src/server.ts": mcpServer(ctx),
      };
    }
  }
}

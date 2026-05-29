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

const DAINTREE_ENGINE_RANGE = ">=0.11.0";

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

function packageJson(ctx: ScaffoldContext, needsReact: boolean): string {
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
  }
  const obj = {
    name: ctx.scopedName,
    version: "0.1.0",
    description: `${ctx.displayName} — a Daintree plugin.`,
    type: "module",
    private: true,
    scripts: {
      build: "vite build",
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
  const entryLiteral = JSON.stringify(entries, null, 6).replace(/\n/g, "\n  ");
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

const GITIGNORE = `node_modules/
dist/
*.dntr
`;

function commandEntry(ctx: ScaffoldContext): string {
  return `import type { PluginHostApi } from "@daintreehq/plugin-sdk";

/**
 * ${ctx.displayName} — command plugin entry. Daintree calls \`activate\` once
 * when the plugin loads; return a disposer to clean up on unload.
 */
export async function activate(host: PluginHostApi): Promise<() => void> {
  const dispose = host.registerAction(
    {
      id: "run",
      title: "${ctx.displayName}: Run",
      description: "Run the ${ctx.displayName} command.",
      category: "${ctx.displayName}",
      kind: "command",
      danger: "safe",
    },
    async () => {
      await host.showToast({ message: "Hello from ${ctx.displayName}", type: "success" });
      return { ran: true };
    }
  );

  return () => {
    dispose();
  };
}
`;
}

function viewEntry(ctx: ScaffoldContext): string {
  return `import type { PluginHostApi } from "@daintreehq/plugin-sdk";

/**
 * ${ctx.displayName} — view plugin entry. The panel UI lives in \`src/panel.tsx\`
 * and is wired through \`contributes.experimental_views\` in plugin.json.
 */
export async function activate(_host: PluginHostApi): Promise<() => void> {
  return () => {};
}
`;
}

function panelComponent(ctx: ScaffoldContext): string {
  return `import React from "react";

/**
 * Panel view for ${ctx.displayName}. Rendered by Daintree when the user opens
 * the contributed view.
 */
export default function Panel(): React.ReactElement {
  return <div style={{ padding: 16 }}>Hello from ${ctx.displayName}</div>;
}
`;
}

function mcpEntry(ctx: ScaffoldContext): string {
  return `import type { PluginHostApi } from "@daintreehq/plugin-sdk";

/**
 * ${ctx.displayName} — MCP plugin entry. The MCP server process is declared in
 * \`contributes.experimental_mcpServers\` (see plugin.json) and spawned by
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
 * Minimal stdio MCP server skeleton for ${ctx.displayName}. Replace this with a
 * real implementation using \`@modelcontextprotocol/sdk\`. Daintree spawns it
 * per the \`command\`/\`args\` in plugin.json and speaks MCP over stdio.
 */
process.stdin.on("data", () => {
  // Wire up an MCP server here (tools/list, tools/call, …).
});
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
        "src/index.ts": commandEntry(ctx),
      };
    }
    case "view": {
      return {
        "plugin.json": manifest(ctx, {
          experimental_views: [
            {
              id: "main",
              name: ctx.displayName,
              componentPath: "dist/panel.js",
              location: "panel",
            },
          ],
        }),
        "package.json": packageJson(ctx, true),
        "tsconfig.json": tsconfig(true),
        "vite.config.ts": viteConfig({ index: "src/index.ts", panel: "src/panel.tsx" }),
        ".gitignore": GITIGNORE,
        "src/index.ts": viewEntry(ctx),
        "src/panel.tsx": panelComponent(ctx),
      };
    }
    case "mcp": {
      return {
        "plugin.json": manifest(ctx, {
          experimental_mcpServers: [
            {
              id: "main",
              name: ctx.displayName,
              command: "node",
              args: ["dist/server.js"],
            },
          ],
        }),
        "package.json": packageJson(ctx, false),
        "tsconfig.json": tsconfig(false),
        "vite.config.ts": viteConfig({ index: "src/index.ts", server: "src/server.ts" }),
        ".gitignore": GITIGNORE,
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
          experimental_views: [
            {
              id: "main",
              name: ctx.displayName,
              componentPath: "dist/panel.js",
              location: "panel",
            },
          ],
          experimental_mcpServers: [
            {
              id: "main",
              name: ctx.displayName,
              command: "node",
              args: ["dist/server.js"],
            },
          ],
        }),
        "package.json": packageJson(ctx, true),
        "tsconfig.json": tsconfig(true),
        "vite.config.ts": viteConfig({
          index: "src/index.ts",
          panel: "src/panel.tsx",
          server: "src/server.ts",
        }),
        ".gitignore": GITIGNORE,
        "src/index.ts": commandEntry(ctx),
        "src/panel.tsx": panelComponent(ctx),
        "src/server.ts": mcpServer(ctx),
      };
    }
  }
}

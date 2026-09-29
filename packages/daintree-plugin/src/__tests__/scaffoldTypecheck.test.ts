import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { scaffoldPlugin } from "../commands/new.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const sdkDir = path.resolve(here, "../../../plugin-sdk");

/**
 * What an agent adds to a fresh view first: a call to its worker, a push
 * subscription, and a kit component. The `@ts-expect-error` lines keep it
 * honest — if `window.electron` collapsed to `any`, they would be unused.
 */
const PROBE = `import { useEffect, useState } from "react";
import { Button } from "@daintreehq/plugin-ui";
import { usePluginEvent } from "@daintreehq/plugin-sdk/react";

export function Probe({ pluginId, panelId }: { pluginId: string; panelId: string }) {
  const [rows, setRows] = useState<unknown>(null);
  useEffect(() => {
    void window.electron.plugin.invoke(pluginId, "list", { limit: 10 }).then(setRows);
    const off = window.electron.plugin.on(pluginId, "changed", () => {});
    const offPanel = window.electron.plugin.onPanel(pluginId, "focus", panelId, () => {});
    return () => {
      off();
      offPanel();
    };
  }, [pluginId, panelId]);
  usePluginEvent<string>(pluginId, "status", (s) => void s.length);
  // @ts-expect-error only the documented plugin-view bridge is declared
  void window.electron.app;
  // @ts-expect-error invoke takes a plugin id and a channel
  void window.electron.plugin.invoke(pluginId);
  return <Button onClick={() => setRows(null)}>{String(rows)}</Button>;
}
`;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "daintree-scaffold-tsc-")));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Install the SDK, React's types and the MCP SDK the way npm would, beside the scaffolded project. */
async function linkDependencies(dir: string): Promise<void> {
  const scoped = path.join(dir, "node_modules", "@daintreehq");
  await fs.mkdir(scoped, { recursive: true });
  await fs.symlink(sdkDir, path.join(scoped, "plugin-sdk"));
  const types = path.join(dir, "node_modules", "@types");
  await fs.mkdir(types, { recursive: true });
  const require = createRequire(import.meta.url);
  for (const name of ["react", "react-dom"]) {
    const resolved = path.dirname(require.resolve(`@types/${name}/package.json`));
    await fs.symlink(resolved, path.join(types, name));
  }
  const mcp = path.join(dir, "node_modules", "@modelcontextprotocol");
  await fs.mkdir(mcp, { recursive: true });
  const mcpSdk = path.dirname(require.resolve("@modelcontextprotocol/sdk/package.json"));
  await fs.symlink(mcpSdk, path.join(mcp, "sdk"));
}

/** `tsc --noEmit -p <dir>` over the generated tsconfig, reporting diagnostics in the project's own files. */
function typecheck(dir: string, override: ts.CompilerOptions = {}): string[] {
  const configPath = path.join(dir, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
  if (config.error) return [ts.flattenDiagnosticMessageText(config.error.messageText, "\n")];
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    // `dist/` only exists after the SDK is built, so the declarations' own
    // import of `/react` is pointed at source; everything else resolves the
    // way it would for an author.
    paths: { "@daintreehq/plugin-sdk/react": [path.join(sdkDir, "src/react.ts")] },
    ...override,
  };
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => dir;
  const program = ts.createProgram(parsed.fileNames, options, host);
  const own = program
    .getSourceFiles()
    .filter((file) => file.fileName.startsWith(path.join(dir, "src")));
  return [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...own.flatMap((file) => [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file),
    ]),
  ].map((d) => {
    const where = d.file ? `${path.relative(dir, d.file.fileName)}: ` : "";
    return `${where}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
  });
}

describe("a scaffolded view typechecks", () => {
  for (const projectLocal of [false, true]) {
    // A project-local plugin may not declare an MCP server, so `full` is installed-only.
    for (const template of projectLocal ? (["view"] as const) : (["view", "full"] as const)) {
      it(`${template}${projectLocal ? " --project" : ""}: its tsconfig opts into the view globals and the kit`, async () => {
        const cwd = projectLocal ? path.join(tmpDir, "repo") : tmpDir;
        if (projectLocal) await fs.mkdir(cwd, { recursive: true });
        const result = await scaffoldPlugin({
          cwd,
          targetDir: "viewer",
          publisher: "acme",
          displayName: "Viewer",
          template,
          ...(projectLocal ? { projectRoot: cwd } : {}),
        });
        const tsconfig = JSON.parse(
          await fs.readFile(path.join(result.dir, "tsconfig.json"), "utf8")
        ) as { compilerOptions: { types?: string[] } };
        expect(tsconfig.compilerOptions.types).toEqual([
          "@daintreehq/plugin-sdk/view-globals",
          "@daintreehq/plugin-sdk/plugin-ui",
        ]);

        await linkDependencies(result.dir);
        await fs.writeFile(path.join(result.dir, "src", "probe.tsx"), PROBE);
        expect(typecheck(result.dir)).toEqual([]);
      }, 60_000);
    }
  }

  it("fails the same probe without the opt-in, which is what the entries fix", async () => {
    const result = await scaffoldPlugin({
      cwd: tmpDir,
      targetDir: "viewer",
      publisher: "acme",
      displayName: "Viewer",
      template: "view",
    });
    await linkDependencies(result.dir);
    await fs.writeFile(path.join(result.dir, "src", "probe.tsx"), PROBE);
    const messages = typecheck(result.dir, { types: [] });
    expect(messages.some((m) => m.includes("'electron' does not exist"))).toBe(true);
    expect(messages.some((m) => m.includes("'@daintreehq/plugin-ui'"))).toBe(true);
  }, 60_000);

  it("keeps worker-only templates free of DOM globals", async () => {
    const result = await scaffoldPlugin({
      cwd: tmpDir,
      targetDir: "runner",
      publisher: "acme",
      displayName: "Runner",
      template: "command",
    });
    const tsconfig = JSON.parse(
      await fs.readFile(path.join(result.dir, "tsconfig.json"), "utf8")
    ) as { compilerOptions: { types?: string[] } };
    expect(tsconfig.compilerOptions.types).toBeUndefined();
  });
});

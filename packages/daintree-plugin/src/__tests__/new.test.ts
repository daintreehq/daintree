import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scaffoldPlugin, runNew, findProjectRoot } from "../commands/new.js";
import { getPluginManifestSchema } from "../../../../electron/schemas/plugin.js";
import { isPluginIconId } from "../../../../shared/config/pluginIconIds.js";
import { TEMPLATE_KINDS } from "../scaffold/templates.js";
import { TerminalRecipeSchema } from "../../../../electron/schemas/ipc.js";
import {
  MAX_TERMINALS_PER_RECIPE,
  RECIPE_CONTROL_CHARS,
  sanitizeRecipeTerminals,
} from "../../../../shared/utils/recipeSanitizer.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-new-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

describe("scaffoldPlugin", () => {
  for (const template of TEMPLATE_KINDS) {
    it(`scaffolds a valid project from the "${template}" template`, async () => {
      const result = await scaffoldPlugin({
        cwd: tmpDir,
        targetDir: "issue-helper",
        publisher: "acme",
        displayName: "Issue Helper",
        template,
      });

      expect(result.scopedName).toBe("acme.issue-helper");
      expect(result.dir).toBe(path.join(tmpDir, "issue-helper"));

      // plugin.json passes the host's manifest schema.
      const manifest = await readJson(path.join(result.dir, "plugin.json"));
      const parsed = getPluginManifestSchema("user").safeParse(manifest);
      expect(parsed.success).toBe(true);
      expect(manifest.name).toBe("acme.issue-helper");

      // package.json + entry exist.
      const pkg = await readJson(path.join(result.dir, "package.json"));
      expect(pkg.name).toBe("acme.issue-helper");
      expect((pkg.scripts as Record<string, string>).package).toContain("daintree-plugin package");
      await expect(fs.access(path.join(result.dir, "src", "index.ts"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(result.dir, ".gitignore"))).resolves.toBeUndefined();

      // The starter .dntrignore documents the mechanism but must not actually
      // drop anything from a fresh plugin — every rule ships commented out.
      const dntrignore = await fs.readFile(path.join(result.dir, ".dntrignore"), "utf8");
      const activeRules = dntrignore
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      expect(activeRules).toEqual([]);
    });
  }

  it("refuses to overwrite an existing directory", async () => {
    await fs.mkdir(path.join(tmpDir, "taken"));
    await expect(
      scaffoldPlugin({
        cwd: tmpDir,
        targetDir: "taken",
        publisher: "acme",
        displayName: "Taken",
        template: "command",
      })
    ).rejects.toThrow(/already exists/);
  });

  it("rejects an invalid publisher segment", async () => {
    await expect(
      scaffoldPlugin({
        cwd: tmpDir,
        targetDir: "ok-name",
        publisher: "Acme Corp",
        displayName: "x",
        template: "command",
      })
    ).rejects.toThrow(/Publisher/);
  });

  it("rejects an invalid plugin-name segment", async () => {
    await expect(
      scaffoldPlugin({
        cwd: tmpDir,
        targetDir: "Bad_Name",
        publisher: "acme",
        displayName: "x",
        template: "command",
      })
    ).rejects.toThrow(/Plugin name/);
  });

  it("escapes a hostile displayName so generated source stays well-formed", async () => {
    const displayName = 'Bob "The" Tool';
    const result = await scaffoldPlugin({
      cwd: tmpDir,
      targetDir: "inject",
      publisher: "acme",
      displayName,
      template: "command",
    });
    const src = await fs.readFile(path.join(result.dir, "src", "index.ts"), "utf8");
    // Values are embedded via JSON.stringify, so inner quotes are escaped rather
    // than left raw to break the surrounding double-quoted literal.
    expect(src).toContain(JSON.stringify(`${displayName}: Run`));
    expect(src).toContain(JSON.stringify(`Hello from ${displayName}`));
    // plugin.json remains valid JSON with the verbatim display name.
    const manifest = await readJson(path.join(result.dir, "plugin.json"));
    expect(manifest.displayName).toBe(displayName);
  });

  it("view template contributes a panel view with a built componentPath", async () => {
    const result = await scaffoldPlugin({
      cwd: tmpDir,
      targetDir: "viewer",
      publisher: "acme",
      displayName: "Viewer",
      template: "view",
    });
    const manifest = await readJson(path.join(result.dir, "plugin.json"));
    const contributes = manifest.contributes as {
      views: Array<{ id: string; componentPath: string }>;
      panels: Array<{ id: string; hasPty?: boolean }>;
    };
    expect(contributes.views[0].componentPath).toBe("dist/panel.js");
    await expect(fs.access(path.join(result.dir, "src", "panel.tsx"))).resolves.toBeUndefined();

    // The runtime (`PluginService.loadPlugin`) registers a panel kind only while
    // iterating declared `panels`, attaching a view's componentPath when ids
    // match. A view with no matching non-PTY panel is ignored, so the scaffold
    // must pair every view with a panel of the same id for it to render.
    const panel = contributes.panels.find((p) => p.id === contributes.views[0].id);
    expect(panel).toBeDefined();
    expect(panel?.hasPty ?? false).toBe(false);
  });

  it("full template pairs its contributed view with a matching panel", async () => {
    const result = await scaffoldPlugin({
      cwd: tmpDir,
      targetDir: "kitchen-sink",
      publisher: "acme",
      displayName: "Kitchen Sink",
      template: "full",
    });
    const manifest = await readJson(path.join(result.dir, "plugin.json"));
    const contributes = manifest.contributes as {
      views: Array<{ id: string }>;
      panels: Array<{ id: string; hasPty?: boolean }>;
    };
    const panel = contributes.panels.find((p) => p.id === contributes.views[0].id);
    expect(panel).toBeDefined();
    expect(panel?.hasPty ?? false).toBe(false);
  });

  for (const template of ["mcp", "full"] as const) {
    it(`"${template}" template builds the server entry through a separate node config`, async () => {
      const result = await scaffoldPlugin({
        cwd: tmpDir,
        targetDir: `srv-${template}`,
        publisher: "acme",
        displayName: "Srv",
        template,
      });

      const clientConfig = await fs.readFile(path.join(result.dir, "vite.config.ts"), "utf8");
      const serverConfig = await fs.readFile(
        path.join(result.dir, "vite.config.server.ts"),
        "utf8"
      );

      // The server entry must NOT go through the browser config — that's the
      // bug where node code is built for the client environment and crashes.
      expect(clientConfig).not.toContain("src/server.ts");
      expect(serverConfig).toContain("src/server.ts");
      expect(serverConfig).toContain('daintreePlugin({ target: "node" })');
      // The second build pass must not wipe the browser output.
      expect(serverConfig).toContain("emptyOutDir: false");

      // The build script chains both passes so a plain `npm run build` produces
      // both bundles.
      const pkg = await readJson(path.join(result.dir, "package.json"));
      const buildScript = (pkg.scripts as Record<string, string>).build;
      expect(buildScript).toContain("vite build");
      expect(buildScript).toContain("--config vite.config.server.ts");
    });
  }

  for (const template of ["command", "view"] as const) {
    it(`"${template}" template has no separate server config`, async () => {
      const result = await scaffoldPlugin({
        cwd: tmpDir,
        targetDir: `nosrv-${template}`,
        publisher: "acme",
        displayName: "NoSrv",
        template,
      });
      await expect(fs.access(path.join(result.dir, "vite.config.server.ts"))).rejects.toThrow();
      const pkg = await readJson(path.join(result.dir, "package.json"));
      expect((pkg.scripts as Record<string, string>).build).toBe("vite build");
    });
  }

  // #10513: the scaffold's engine range must satisfy host versions past 0.11.
  // `^0.11.0` resolves to `>=0.11.0 <0.12.0` and would be rejected by the host.
  for (const template of TEMPLATE_KINDS) {
    it(`"${template}" template pins an open-ended engine range satisfying recent hosts`, async () => {
      const result = await scaffoldPlugin({
        cwd: tmpDir,
        targetDir: "engine-check",
        publisher: "acme",
        displayName: "Engine Check",
        template,
      });
      const manifest = await readJson(path.join(result.dir, "plugin.json"));
      const range = (manifest.engines as { daintree?: string }).daintree;
      expect(range).toBeDefined();
      const semver = await import("semver");
      // A current host version must satisfy the scaffolded range — the bug was a
      // caret range that excluded everything past 0.11.x.
      expect(semver.satisfies("0.19.1", range!)).toBe(true);
      expect(semver.satisfies("1.0.0", range!)).toBe(true);
    });
  }

  it("React templates declare @types/react devDependencies; non-React ones don't (#10513)", async () => {
    const viewPkg = (await scaffoldView("typed-view")).pkg;
    const viewDev = viewPkg.devDependencies as Record<string, string>;
    expect(viewDev["@types/react"]).toBeDefined();
    expect(viewDev["@types/react-dom"]).toBeDefined();

    const cmd = await scaffoldPlugin({
      cwd: tmpDir,
      targetDir: "typed-cmd",
      publisher: "acme",
      displayName: "Typed Cmd",
      template: "command",
    });
    const cmdDev = (await readJson(path.join(cmd.dir, "package.json"))).devDependencies as Record<
      string,
      string
    >;
    expect(cmdDev["@types/react"]).toBeUndefined();
  });

  it("MCP templates ship a working SDK server, not a hanging stdin stub (#10513)", async () => {
    for (const template of ["mcp", "full"] as const) {
      const result = await scaffoldPlugin({
        cwd: tmpDir,
        targetDir: `sdk-${template}`,
        publisher: "acme",
        displayName: "Server Demo",
        template,
      });
      const pkg = await readJson(path.join(result.dir, "package.json"));
      // The SDK is a runtime dependency (the spawned `node dist/server.js` needs
      // it at runtime), not a devDependency.
      const deps = pkg.dependencies as Record<string, string>;
      expect(deps["@modelcontextprotocol/sdk"]).toBeDefined();
      expect((pkg.devDependencies as Record<string, string>)["@modelcontextprotocol/sdk"]).toBe(
        undefined
      );

      const server = await fs.readFile(path.join(result.dir, "src", "server.ts"), "utf8");
      expect(server).toContain("StdioServerTransport");
      expect(server).toContain("McpServer");
      // The old stub listened on stdin and never answered the handshake.
      expect(server).not.toContain("process.stdin");
    }
  });

  it("pins an SDK range that actually contains McpServer + registerTool (#10513)", async () => {
    // McpServer (server/mcp.js) arrived in 1.3.0 and registerTool in 1.12.0, so a
    // `^1.0.0` range could resolve to a release missing the APIs the generated
    // server imports. Assert the floor is >=1.12.
    for (const template of ["mcp", "full"] as const) {
      const result = await scaffoldPlugin({
        cwd: tmpDir,
        targetDir: `sdkver-${template}`,
        publisher: "acme",
        displayName: "Sdk Ver",
        template,
      });
      const deps = (await readJson(path.join(result.dir, "package.json"))).dependencies as Record<
        string,
        string
      >;
      const range = deps["@modelcontextprotocol/sdk"];
      expect(range).toBeDefined();
      const semver = await import("semver");
      const min = semver.minVersion(range!);
      expect(min).not.toBeNull();
      expect(semver.gte(min!, "1.12.0")).toBe(true);
    }
  });

  it("full template ships both React types and the MCP SDK dep (#10513)", async () => {
    const result = await scaffoldPlugin({
      cwd: tmpDir,
      targetDir: "full-deps",
      publisher: "acme",
      displayName: "Full Deps",
      template: "full",
    });
    const pkg = await readJson(path.join(result.dir, "package.json"));
    const dev = pkg.devDependencies as Record<string, string>;
    const deps = pkg.dependencies as Record<string, string>;
    expect(dev["@types/react"]).toBeDefined();
    expect(dev["@types/react-dom"]).toBeDefined();
    expect(deps["@modelcontextprotocol/sdk"]).toBeDefined();
  });

  it("non-React MCP template needs no @types/node (server avoids Node globals) (#10513)", async () => {
    const result = await scaffoldPlugin({
      cwd: tmpDir,
      targetDir: "mcp-types",
      publisher: "acme",
      displayName: "Mcp Types",
      template: "mcp",
    });
    const pkg = await readJson(path.join(result.dir, "package.json"));
    expect((pkg.devDependencies as Record<string, string>)["@types/node"]).toBeUndefined();
    const server = await fs.readFile(path.join(result.dir, "src", "server.ts"), "utf8");
    // No bare `process.`/`console.` usage that would require @types/node under the
    // template's ES2022-only lib.
    expect(server).not.toMatch(/\bprocess\./);
  });

  it("emits a well-aligned vite entry map — closing brace matches the opener (#10513)", async () => {
    const result = await scaffoldView("aligned");
    const vite = await fs.readFile(path.join(result.dir, "vite.config.ts"), "utf8");
    const lines = vite.split("\n");
    const openIdx = lines.findIndex((l) => l.trimStart().startsWith("entry:"));
    expect(openIdx).toBeGreaterThanOrEqual(0);
    const indentOf = (l: string) => l.length - l.trimStart().length;
    const openIndent = indentOf(lines[openIdx]);
    const closeIdx = lines.findIndex((l, i) => i > openIdx && l.trimStart() === "},");
    expect(closeIdx).toBeGreaterThan(openIdx);
    // The bug left the closing brace at 2 spaces while `entry:` sat at 6.
    expect(indentOf(lines[closeIdx])).toBe(openIndent);
  });

  it("scaffolds panels with a recognized panel iconId (#10513)", async () => {
    const result = await scaffoldView("iconic");
    const manifest = await readJson(path.join(result.dir, "plugin.json"));
    const panels = (manifest.contributes as { panels: Array<{ iconId: string }> }).panels;
    expect(panels.length).toBeGreaterThan(0);
    for (const panel of panels) {
      // Guards against the scaffold drifting to an iconId that renders as the
      // generic terminal fallback (the advisory validator would flag it).
      expect(isPluginIconId(panel.iconId)).toBe(true);
    }
  });

  describe("runNew non-interactive (--yes)", () => {
    // runNew resolves the scaffold target from process.cwd(); stub it rather
    // than process.chdir(tmpDir), since chdir is unsupported under the threads
    // pool (worker_threads) and is process-global — unsafe with parallel files.
    let cwdSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    });
    afterEach(() => {
      cwdSpy.mockRestore();
    });

    it("scaffolds from flags with a title-cased display name", async () => {
      await runNew("issue-helper", { yes: true, publisher: "acme", template: "command" });
      const manifest = await readJson(path.join(tmpDir, "issue-helper", "plugin.json"));
      expect(manifest.name).toBe("acme.issue-helper");
      expect(manifest.displayName).toBe("Issue Helper");
      const parsed = getPluginManifestSchema("user").safeParse(manifest);
      expect(parsed.success).toBe(true);
    });

    it("defaults the template to command when --template is omitted", async () => {
      await runNew("defaulted", { yes: true, publisher: "acme" });
      const manifest = (await readJson(path.join(tmpDir, "defaulted", "plugin.json"))) as {
        contributes: { commands: unknown[] };
      };
      expect(manifest.contributes.commands.length).toBeGreaterThan(0);
    });

    it("errors when --publisher is missing", async () => {
      await expect(runNew("nopub", { yes: true })).rejects.toThrow(/--publisher/);
    });

    it("errors when the name argument is missing", async () => {
      await expect(runNew(undefined, { yes: true, publisher: "acme" })).rejects.toThrow(/name/);
    });

    it("errors on an unknown --template value", async () => {
      await expect(
        runNew("badtmpl", { yes: true, publisher: "acme", template: "wizard" })
      ).rejects.toThrow(/Unknown template/);
    });
  });

  async function scaffoldView(
    targetDir: string
  ): Promise<{ dir: string; pkg: Record<string, unknown> }> {
    const result = await scaffoldPlugin({
      cwd: tmpDir,
      targetDir,
      publisher: "acme",
      displayName: "View Plugin",
      template: "view",
    });
    return { dir: result.dir, pkg: await readJson(path.join(result.dir, "package.json")) };
  }
});

/**
 * Project-local scaffolding (`daintree-plugin new --project`). Same templates,
 * different contract: the plugin is committed into the project at
 * `.daintree/plugins/<manifest name>/`, loads from that committed `dist/`, and
 * ships a watcher recipe next to the project's other recipes.
 */
describe("scaffoldPlugin --project", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = path.join(tmpDir, "proj");
    await fs.mkdir(path.join(projectRoot, ".daintree"), { recursive: true });
  });

  async function scaffoldProject(
    template: (typeof TEMPLATE_KINDS)[number] = "command",
    targetDir = "issue-helper"
  ) {
    return scaffoldPlugin({
      cwd: tmpDir,
      targetDir,
      publisher: "acme",
      displayName: "Issue Helper",
      template,
      projectRoot,
    });
  }

  it("writes into <projectRoot>/.daintree/plugins/<manifest name>/", async () => {
    const result = await scaffoldProject();
    // Discovery keys a project plugin by its directory, so the directory is
    // named after the manifest `name` — not the bare plugin segment.
    expect(result.dir).toBe(path.join(projectRoot, ".daintree", "plugins", "acme.issue-helper"));
    expect(path.basename(result.dir)).toBe(result.scopedName);
    const manifest = await readJson(path.join(result.dir, "plugin.json"));
    expect(manifest.name).toBe(path.basename(result.dir));
  });

  it("marks the manifest as project scope and is otherwise a valid manifest", async () => {
    const result = await scaffoldProject();
    const manifest = await readJson(path.join(result.dir, "plugin.json"));
    expect(manifest.scope).toBe("project");

    // `scope` is added to the manifest schema by the project-plugin host phase.
    // Until that lands the schema is a strictObject that rejects the key, so
    // validate everything else here rather than assert a failure we expect to
    // stop being a failure.
    const { scope: _scope, ...rest } = manifest;
    const parsed = getPluginManifestSchema(false).safeParse(rest);
    expect(parsed.success).toBe(true);
  });

  it("ships a .gitignore that force-includes dist/", async () => {
    const result = await scaffoldProject();
    const gitignore = await fs.readFile(path.join(result.dir, ".gitignore"), "utf8");
    const rules = gitignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    // The committed dist/ IS the load contract. Ignoring it ships a plugin that
    // cannot load anywhere else, so no rule may exclude it...
    expect(rules.some((rule) => /^dist\/?$/.test(rule))).toBe(false);
    // ...and both negations must be present, because a repo that ignores
    // `dist/` at its root would otherwise swallow this directory too. `!dist/`
    // re-includes the directory so git descends into it; `!dist/**` re-includes
    // the files, which a parent rule matching contents (`dist/*`, `**/dist/**`)
    // would otherwise still exclude.
    expect(rules).toContain("!dist/");
    expect(rules).toContain("!dist/**");
    // The directory negation has to come first, or git never descends.
    expect(rules.indexOf("!dist/")).toBeLessThan(rules.indexOf("!dist/**"));
  });

  it("drops the packaging-only files an installed plugin gets", async () => {
    const result = await scaffoldProject();
    // A project plugin is distributed by being committed, never as a .dntr.
    await expect(fs.access(path.join(result.dir, ".dntrignore"))).rejects.toThrow();
    const pkg = await readJson(path.join(result.dir, "package.json"));
    expect((pkg.scripts as Record<string, string>).package).toBeUndefined();
  });

  it("adds a dev watcher script, plus a second one for server templates", async () => {
    for (const template of TEMPLATE_KINDS) {
      const result = await scaffoldProject(template, `dev-${template}`);
      const scripts = (await readJson(path.join(result.dir, "package.json"))).scripts as Record<
        string,
        string
      >;
      const hasServer = template === "mcp" || template === "full";
      // `vite build --watch` runs one config object at a time, so a Node entry
      // needs its own watcher rather than a chained command — and two watchers
      // sharing dist/ both need --no-emptyOutDir, or each browser save deletes
      // the server bundle (the same fix resolveVitePlan applies to `dev`).
      expect(scripts.dev).toBe(
        hasServer ? "vite build --watch --no-emptyOutDir" : "vite build --watch"
      );
      expect(scripts["dev:server"]).toBe(
        hasServer ? "vite build --watch --config vite.config.server.ts --no-emptyOutDir" : undefined
      );
    }
  });

  it("emits inline source maps with absolute sources", async () => {
    const result = await scaffoldProject("full", "maps");
    for (const config of ["vite.config.ts", "vite.config.server.ts"]) {
      const text = await fs.readFile(path.join(result.dir, config), "utf8");
      // Sidecar .map files would have to be served over plugin://; inline
      // avoids the route. Absolute `sources` put breakpoints in the real file.
      expect(text).toContain('sourcemap: "inline"');
      expect(text).toContain("sourcemapPathTransform");
      expect(text).toContain('import path from "node:path";');
    }
    // The generated config imports node:path, so the types must be declared.
    const dev = (await readJson(path.join(result.dir, "package.json"))).devDependencies as Record<
      string,
      string
    >;
    expect(dev["@types/node"]).toBeDefined();
  });

  it("writes a watcher recipe that survives the in-repo trust boundary", async () => {
    const result = await scaffoldProject("full", "recipe-full");
    expect(result.recipePath).toBe(
      path.join(projectRoot, ".daintree", "recipes", "acme.recipe-full-watch.json")
    );

    const recipe = await readJson(result.recipePath!);
    // In-repo recipes moved off name-derived ids (#9195) so a rename cannot
    // change a recipe's identity.
    expect(recipe.id).not.toMatch(/^inrepo-/);
    expect(typeof recipe.id).toBe("string");
    // `readInRepoRecipesWithHashes` parses with this schema, then content-checks
    // every terminal. A recipe that fails either is silently dropped.
    const parsed = TerminalRecipeSchema.safeParse(recipe);
    expect(parsed.success).toBe(true);

    const terminals = recipe.terminals as Array<Record<string, unknown>>;
    expect(terminals.length).toBeLessThanOrEqual(MAX_TERMINALS_PER_RECIPE);
    // Nothing is dropped: the sanitized list is the same length as the written one.
    expect(sanitizeRecipeTerminals(terminals)).toHaveLength(terminals.length);
    for (const terminal of terminals) {
      expect(RECIPE_CONTROL_CHARS.test(terminal.command as string)).toBe(false);
      // Commands are typed into an interactive shell rooted at the worktree.
      expect(terminal.command).toContain(".daintree/plugins/acme.recipe-full");
    }
    // Both watchers: the browser bundle and the Node server entry.
    expect(terminals).toHaveLength(2);
  });

  it("keeps control characters out of the committed recipe", async () => {
    // `sanitizeRecipeTerminals` never inspects `title`, and the interactive
    // display-name prompt does not validate, so a pasted escape sequence would
    // otherwise be committed verbatim.
    const result = await scaffoldPlugin({
      cwd: tmpDir,
      targetDir: "hostile",
      publisher: "acme",
      displayName: "Bad\u001b[31mName",
      template: "command",
      projectRoot,
    });
    const recipe = await readJson(result.recipePath!);
    for (const terminal of recipe.terminals as Array<Record<string, string>>) {
      // eslint-disable-next-line no-control-regex
      expect(terminal.title).not.toMatch(/[\u0000-\u001F\u007F]/);
    }
  });

  it("caps the scoped name at the manifest schema's 64 characters", async () => {
    await expect(
      scaffoldPlugin({
        cwd: tmpDir,
        targetDir: "a".repeat(60),
        publisher: "acme",
        displayName: "Long",
        template: "command",
        projectRoot,
      })
    ).rejects.toThrow(/at most 64/);
  });

  it("refuses to clobber an existing recipe, and writes nothing when it would", async () => {
    const recipeDir = path.join(projectRoot, ".daintree", "recipes");
    await fs.mkdir(recipeDir, { recursive: true });
    const existing = path.join(recipeDir, "acme.issue-helper-watch.json");
    await fs.writeFile(existing, "{}", "utf8");

    await expect(scaffoldProject()).rejects.toThrow(/Recipe already exists/);
    expect(await fs.readFile(existing, "utf8")).toBe("{}");
    // The plugin directory must not be half-written either.
    await expect(
      fs.access(path.join(projectRoot, ".daintree", "plugins", "acme.issue-helper"))
    ).rejects.toThrow();
  });

  it("cannot be steered outside the project root by a hostile name", async () => {
    for (const targetDir of ["../escape", "..", ".hidden", "a/b", "a\\b"]) {
      await expect(
        scaffoldPlugin({
          cwd: tmpDir,
          targetDir,
          publisher: "acme",
          displayName: "x",
          template: "command",
          projectRoot,
        })
      ).rejects.toThrow(/Plugin name/);
    }
    for (const publisher of ["../escape", "..", "a/b"]) {
      await expect(
        scaffoldPlugin({
          cwd: tmpDir,
          targetDir: "ok-name",
          publisher,
          displayName: "x",
          template: "command",
          projectRoot,
        })
      ).rejects.toThrow(/Publisher/);
    }
  });
});

describe("findProjectRoot", () => {
  it("finds the nearest ancestor holding .daintree/", async () => {
    const root = path.join(tmpDir, "proj");
    const nested = path.join(root, "packages", "thing");
    await fs.mkdir(path.join(root, ".daintree"), { recursive: true });
    await fs.mkdir(nested, { recursive: true });
    expect(await findProjectRoot(nested)).toBe(root);
  });

  it("accepts a .git file, as a git worktree has", async () => {
    const root = path.join(tmpDir, "wt");
    await fs.mkdir(root, { recursive: true });
    // In a worktree `.git` is a file pointing at the real git dir, not a
    // directory — and a fresh worktree is the case this feature exists for.
    await fs.writeFile(path.join(root, ".git"), "gitdir: /elsewhere\n", "utf8");
    expect(await findProjectRoot(root)).toBe(root);
  });

  it("returns null when nothing above looks like a project", async () => {
    const orphan = path.join(tmpDir, "orphan");
    await fs.mkdir(orphan, { recursive: true });
    expect(await findProjectRoot(orphan)).toBeNull();
  });
});

describe("runNew --project", () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    cwdSpy?.mockRestore();
  });

  it("resolves the project root from the cwd and scaffolds into it", async () => {
    const root = path.join(tmpDir, "proj");
    const nested = path.join(root, "src", "deep");
    await fs.mkdir(path.join(root, ".daintree"), { recursive: true });
    await fs.mkdir(nested, { recursive: true });
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(nested);

    await runNew("dash", { yes: true, publisher: "acme", project: true });

    const manifest = await readJson(
      path.join(root, ".daintree", "plugins", "acme.dash", "plugin.json")
    );
    expect(manifest.name).toBe("acme.dash");
    expect(manifest.scope).toBe("project");
    await expect(
      fs.access(path.join(root, ".daintree", "recipes", "acme.dash-watch.json"))
    ).resolves.toBeUndefined();
  });

  it.each(["mcp", "full"] as const)(
    "refuses the %s template under --project instead of writing an unloadable manifest",
    async (template) => {
      // The project-origin schema rejects `contributes.mcpServers`, so these two
      // templates would scaffold a manifest the host silently declines to load.
      const root = path.join(tmpDir, `proj-${template}`);
      await fs.mkdir(path.join(root, ".daintree"), { recursive: true });
      cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);

      await expect(
        runNew("dash", { yes: true, publisher: "acme", project: true, template })
      ).rejects.toThrow(/may not declare/);
      await expect(fs.access(path.join(root, ".daintree", "plugins"))).rejects.toThrow();
    }
  );

  it.each(["command", "view"] as const)("still scaffolds the %s template", async (template) => {
    const root = path.join(tmpDir, `proj-ok-${template}`);
    await fs.mkdir(path.join(root, ".daintree"), { recursive: true });
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);

    await runNew("dash", { yes: true, publisher: "acme", project: true, template });

    const manifest = await readJson(
      path.join(root, ".daintree", "plugins", "acme.dash", "plugin.json")
    );
    expect((manifest.contributes as Record<string, unknown>).mcpServers).toBeUndefined();
  });

  it("fails with a clear message outside a project rather than picking a directory", async () => {
    const orphan = path.join(tmpDir, "orphan");
    await fs.mkdir(orphan, { recursive: true });
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(orphan);

    await expect(runNew("dash", { yes: true, publisher: "acme", project: true })).rejects.toThrow(
      /--project needs a project/
    );
    await expect(fs.access(path.join(orphan, ".daintree"))).rejects.toThrow();
  });
});

/**
 * The committed fixture the project-plugin loader phase discovers. Asserted
 * here because this package owns the on-disk shape the scaffold produces, and
 * a fixture nothing checks rots into a shape the loader can never load.
 */
describe("project-local fixture", () => {
  const fixtureDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "plugins",
    "fixtures",
    "project-local",
    ".daintree",
    "plugins",
    "acme.project-hello"
  );

  it("is a loadable project-local plugin with a committed dist/", async () => {
    const manifest = await readJson(path.join(fixtureDir, "plugin.json"));
    expect(manifest.scope).toBe("project");
    // Discovery keys a project plugin by its directory name.
    expect(manifest.name).toBe(path.basename(fixtureDir));

    // Everything the manifest points at must actually be committed — the host
    // never builds this, so a missing file is an unloadable plugin.
    const views = (manifest.contributes as { views: Array<{ componentPath: string }> }).views;
    for (const rel of [manifest.main as string, ...views.map((v) => v.componentPath)]) {
      await expect(fs.access(path.join(fixtureDir, rel))).resolves.toBeUndefined();
    }
  });

  it("force-includes dist/ the same way the scaffold does", async () => {
    const gitignore = await fs.readFile(path.join(fixtureDir, ".gitignore"), "utf8");
    const rules = gitignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    expect(rules.some((rule) => /^dist\/?$/.test(rule))).toBe(false);
    expect(rules).toContain("!dist/");
    expect(rules).toContain("!dist/**");
  });
});

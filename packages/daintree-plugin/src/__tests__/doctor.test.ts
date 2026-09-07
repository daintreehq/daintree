import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { runDoctor } from "../commands/doctor.js";

let projectRoot: string;

const VALID_MANIFEST = {
  name: "acme.demo",
  version: "1.0.0",
  scope: "project",
  displayName: "Demo",
  main: "dist/index.mjs",
  engines: { daintree: ">=0.11.0" },
  capabilities: [],
  contributes: {
    panels: [{ id: "main", name: "Demo", iconId: "gauge", color: "var(--theme-category-orange)" }],
    views: [{ id: "main", componentPath: "dist/panel.js", location: "panel" }],
  },
};

const WORKER_ENTRY = "export async function activate(host) {\n  return () => {};\n}\n";
const VIEW_ENTRY = "export default function Panel() {\n  return null;\n}\n";

async function writePlugin(
  dirName: string,
  manifest: unknown,
  files: Record<string, string> = { "dist/index.mjs": WORKER_ENTRY, "dist/panel.js": VIEW_ENTRY }
): Promise<string> {
  const dir = path.join(projectRoot, ".daintree", "plugins", dirName);
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest), "utf8");
  for (const [relative, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await fs.writeFile(path.join(dir, relative), contents, "utf8");
  }
  return dir;
}

async function initRepo(): Promise<void> {
  await execa("git", ["-C", projectRoot, "init", "-q"]);
  await execa("git", ["-C", projectRoot, "config", "user.email", "t@example.com"]);
  await execa("git", ["-C", projectRoot, "config", "user.name", "Test"]);
}

async function commitAll(): Promise<void> {
  await execa("git", ["-C", projectRoot, "add", "-A"]);
  await execa("git", ["-C", projectRoot, "commit", "-q", "-m", "add plugin"]);
}

beforeEach(async () => {
  // `realpath` because macOS hands out /var/… symlinks for temp dirs, and git
  // reports the resolved path — an unresolved root makes every `git -C` path
  // relative computation disagree with git's own.
  projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "daintree-doctor-")));
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe("runDoctor", () => {
  it("reports no plugins when the project has no plugins directory", async () => {
    const result = await runDoctor(projectRoot, { offline: true });
    expect(result.ok).toBe(true);
    expect(result.plugins).toEqual([]);
  });

  it("passes a committed, well-formed project plugin", async () => {
    await initRepo();
    await writePlugin("acme.demo", VALID_MANIFEST);
    await commitAll();

    const result = await runDoctor(projectRoot, { offline: true });
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].errors).toEqual([]);
    expect(result.plugins[0].pluginId).toBe("acme.demo");
    expect(result.ok).toBe(true);
  });

  it("rejects a caret engine range the manifest schema accepts", async () => {
    await initRepo();
    await writePlugin("acme.demo", { ...VALID_MANIFEST, engines: { daintree: "^0.11.0" } });
    await commitAll();

    const result = await runDoctor(projectRoot, { offline: true });
    const caret = result.plugins[0].errors.find((e) => e.includes("caret"));
    expect(caret).toBeDefined();
    expect(caret).toContain(">=0.11.0");
    expect(result.ok).toBe(false);
  });

  it("catches build output that is present but untracked", async () => {
    await initRepo();
    await writePlugin("acme.demo", VALID_MANIFEST);
    // Commit only the manifest, leaving dist/ present-but-untracked — the exact
    // state that works for the author and for nobody who clones.
    await execa("git", ["-C", projectRoot, "add", ".daintree/plugins/acme.demo/plugin.json"]);
    await execa("git", ["-C", projectRoot, "commit", "-q", "-m", "manifest only"]);

    const result = await runDoctor(projectRoot, { offline: true });
    const untracked = result.plugins[0].errors.filter((e) => e.includes("not tracked by git"));
    expect(untracked.length).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(false);
  });

  it("catches build output an ancestor .gitignore excludes", async () => {
    await initRepo();
    await fs.writeFile(path.join(projectRoot, ".gitignore"), "dist/\n", "utf8");
    await writePlugin("acme.demo", VALID_MANIFEST);

    const result = await runDoctor(projectRoot, { offline: true });
    const ignored = result.plugins[0].errors.filter((e) => e.includes("git-ignored"));
    expect(ignored.length).toBeGreaterThanOrEqual(2);
    expect(ignored[0]).toContain(".gitignore");
    expect(result.ok).toBe(false);
  });

  it("accepts build output rescued by the plugin's own negations", async () => {
    await initRepo();
    await fs.writeFile(path.join(projectRoot, ".gitignore"), "dist/\n", "utf8");
    const dir = await writePlugin("acme.demo", VALID_MANIFEST);
    await fs.writeFile(path.join(dir, ".gitignore"), "!dist/\n!dist/**\n", "utf8");
    await commitAll();

    const result = await runDoctor(projectRoot, { offline: true });
    expect(result.plugins[0].errors).toEqual([]);
  });

  it("catches a CommonJS bundle that would throw at import", async () => {
    await initRepo();
    await writePlugin("acme.demo", VALID_MANIFEST, {
      "dist/index.mjs": "module.exports = { activate() {} };\n",
      "dist/panel.js": VIEW_ENTRY,
    });
    await commitAll();

    const result = await runDoctor(projectRoot, { offline: true });
    const cjs = result.plugins[0].errors.find((e) => e.includes("CommonJS"));
    expect(cjs).toBeDefined();
    expect(result.ok).toBe(false);
  });

  it("catches build output that does not parse", async () => {
    await initRepo();
    await writePlugin("acme.demo", VALID_MANIFEST, {
      "dist/index.mjs": "export const a = ;\n",
      "dist/panel.js": VIEW_ENTRY,
    });
    await commitAll();

    const result = await runDoctor(projectRoot, { offline: true });
    expect(result.plugins[0].errors.some((e) => e.includes("doesn't parse as ESM"))).toBe(true);
  });

  it("carries the schema rejection for a manifest the host would refuse", async () => {
    await initRepo();
    const { contributes, ...rest } = VALID_MANIFEST;
    await writePlugin("acme.demo", {
      ...rest,
      contributes: {
        ...contributes,
        panels: [{ id: "main", name: "Demo", iconId: "gauge" }],
      },
    });
    await commitAll();

    const result = await runDoctor(projectRoot, { offline: true });
    expect(result.plugins[0].errors.some((e) => e.includes("color"))).toBe(true);
  });

  it("refuses a manifest that omits scope, which the host rejects under this root", async () => {
    await initRepo();
    // Every directory doctor walks lives under `.daintree/plugins/`, so the
    // project rules apply whatever the manifest claims about itself. Inferring
    // the origin from `scope` passed this exact manifest.
    const { scope: _scope, ...withoutScope } = VALID_MANIFEST;
    await writePlugin("acme.demo", withoutScope);
    await commitAll();

    const result = await runDoctor(projectRoot, { offline: true });
    expect(result.plugins[0].errors.some((e) => e.includes("scope"))).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("refuses a build target that climbs out of the plugin directory", async () => {
    await initRepo();
    await fs.writeFile(path.join(projectRoot, "shared.mjs"), WORKER_ENTRY, "utf8");
    await writePlugin("acme.demo", { ...VALID_MANIFEST, main: "../../../shared.mjs" });
    await commitAll();

    const result = await runDoctor(projectRoot, { offline: true });
    // Committed, tracked, and valid ESM — and still unloadable, because the
    // host refuses an entry path that leaves the plugin directory.
    const escape = result.plugins[0].errors.find((e) => e.includes("outside the plugin directory"));
    expect(escape).toBeDefined();
    expect(result.ok).toBe(false);
  });

  it("keeps several plugin directories independent and reports them all", async () => {
    await initRepo();
    await writePlugin("acme.good", VALID_MANIFEST);
    await writePlugin("acme.bad", {
      ...VALID_MANIFEST,
      contributes: {
        ...VALID_MANIFEST.contributes,
        panels: [{ id: "main", name: "Demo", iconId: "gauge" }],
      },
    });
    // A directory with no manifest at all.
    await fs.mkdir(path.join(projectRoot, ".daintree", "plugins", "acme.empty"), {
      recursive: true,
    });
    await commitAll();

    const result = await runDoctor(projectRoot, { offline: true });
    expect(result.plugins.map((p) => p.dirName)).toEqual(["acme.bad", "acme.empty", "acme.good"]);
    expect(result.plugins[0].errors.length).toBeGreaterThan(0);
    expect(result.plugins[1].pluginId).toBeNull();
    expect(result.plugins[2].errors).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it("skips the git checks outside a repository and says so", async () => {
    await writePlugin("acme.demo", VALID_MANIFEST);

    const result = await runDoctor(projectRoot, { offline: true });
    expect(result.plugins[0].errors).toEqual([]);
    expect(result.plugins[0].warnings.some((w) => w.includes("Not a git repository"))).toBe(true);
  });

  it("reports that the host was not consulted when offline", async () => {
    const result = await runDoctor(projectRoot, { offline: true });
    expect(result.host.reachable).toBe(false);
    expect(result.host.note).toContain("offline");
  });
});

import { describe, expect, it } from "vitest";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { getCompletionParser, type RawCompletionEntry } from "../completionParsers.js";

async function makeCodexHome(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "daintree-codex-plugins-"));
}

async function write(filePath: string, contents: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, contents, "utf8");
}

async function writeManifest(
  codexHome: string,
  marketplace: string,
  plugin: string,
  version: string,
  manifest: unknown,
  manifestDir = ".codex-plugin"
): Promise<void> {
  await write(
    path.join(
      codexHome,
      "plugins",
      "cache",
      marketplace,
      plugin,
      version,
      manifestDir,
      "plugin.json"
    ),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest)
  );
}

function ifaceManifest(name: string, shortDescription: string): object {
  return {
    name,
    description: `top-level ${name} description`,
    interface: { displayName: name.toUpperCase(), shortDescription },
  };
}

async function runRegistry(codexHome: string): Promise<RawCompletionEntry[]> {
  const parser = getCompletionParser("codex-plugin-registry");
  expect(parser).toBeDefined();
  return parser!(codexHome);
}

function byName(entries: RawCompletionEntry[]): Map<string, RawCompletionEntry> {
  return new Map(entries.map((e) => [e.nameParts.join(":"), e]));
}

describe("codex-plugin-registry parser", () => {
  it("surfaces only enabled plugins, keyed by name@marketplace, with manifest descriptions", async () => {
    const home = await makeCodexHome();
    try {
      await write(
        path.join(home, "config.toml"),
        [
          `[plugins."github@openai-curated"]`,
          `enabled = true`,
          ``,
          `[plugins."gmail@openai-curated"]`,
          `enabled = true`,
        ].join("\n")
      );
      await writeManifest(
        home,
        "openai-curated",
        "github",
        "3fdeeb49",
        ifaceManifest("github", "Triage PRs and CI")
      );
      await writeManifest(
        home,
        "openai-curated",
        "gmail",
        "3fdeeb49",
        ifaceManifest("gmail", "Read and manage Gmail")
      );

      const entries = await runRegistry(home);
      const map = byName(entries);

      expect([...map.keys()].sort()).toEqual(["github", "gmail"]);
      expect(map.get("github")).toMatchObject({
        nameParts: ["github"],
        description: "Triage PRs and CI",
        userInvocable: true,
      });
      expect(map.get("github")!.relativeSourcePath).toBe(
        path.join(
          "plugins",
          "cache",
          "openai-curated",
          "github",
          "3fdeeb49",
          ".codex-plugin",
          "plugin.json"
        )
      );
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });

  it("excludes cached-but-not-enabled marketplaces (no duplicate, no stale remote)", async () => {
    const home = await makeCodexHome();
    try {
      await write(
        path.join(home, "config.toml"),
        [`[plugins."github@openai-curated"]`, `enabled = true`].join("\n")
      );
      // Enabled entry.
      await writeManifest(
        home,
        "openai-curated",
        "github",
        "3fdeeb49",
        ifaceManifest("github", "enabled github")
      );
      // Same plugin name in a different, un-enabled marketplace — must be skipped.
      await writeManifest(
        home,
        "openai-curated-remote",
        "github",
        "0.1.8",
        ifaceManifest("github", "remote github")
      );
      // A plugin only present in the un-enabled remote marketplace — must be skipped.
      await writeManifest(
        home,
        "openai-curated-remote",
        "openai-templates",
        "0.1.0",
        ifaceManifest("openai-templates", "templates")
      );

      const entries = await runRegistry(home);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ nameParts: ["github"], description: "enabled github" });
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });

  it("treats a table without `enabled = true` as disabled", async () => {
    const home = await makeCodexHome();
    try {
      await write(
        path.join(home, "config.toml"),
        [
          `[plugins."github@openai-curated"]`,
          `# no enabled key`,
          ``,
          `[plugins."gmail@openai-curated"]`,
          `enabled = false`,
        ].join("\n")
      );
      await writeManifest(home, "openai-curated", "github", "v1", ifaceManifest("github", "gh"));
      await writeManifest(home, "openai-curated", "gmail", "v1", ifaceManifest("gmail", "gm"));

      const entries = await runRegistry(home);
      expect(entries).toEqual([]);
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });

  it("prefers the `local` version and reads its manifest description", async () => {
    const home = await makeCodexHome();
    try {
      await write(
        path.join(home, "config.toml"),
        [`[plugins."github@openai-curated"]`, `enabled = true`].join("\n")
      );
      await writeManifest(
        home,
        "openai-curated",
        "github",
        "0.9.9",
        ifaceManifest("github", "released")
      );
      await writeManifest(
        home,
        "openai-curated",
        "github",
        "local",
        ifaceManifest("github", "local build")
      );

      const entries = await runRegistry(home);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.description).toBe("local build");
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });

  it("falls back to .claude-plugin/plugin.json when .codex-plugin is absent", async () => {
    const home = await makeCodexHome();
    try {
      await write(
        path.join(home, "config.toml"),
        [`[plugins."github@openai-curated"]`, `enabled = true`].join("\n")
      );
      await writeManifest(
        home,
        "openai-curated",
        "github",
        "v1",
        ifaceManifest("github", "claude-compat"),
        ".claude-plugin"
      );

      const entries = await runRegistry(home);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ nameParts: ["github"], description: "claude-compat" });
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });

  it("falls back to top-level description, then null, and fails closed on malformed JSON", async () => {
    const home = await makeCodexHome();
    try {
      await write(
        path.join(home, "config.toml"),
        [
          `[plugins."toplevel@m"]`,
          `enabled = true`,
          ``,
          `[plugins."nodesc@m"]`,
          `enabled = true`,
          ``,
          `[plugins."broken@m"]`,
          `enabled = true`,
        ].join("\n")
      );
      // No interface.shortDescription → uses top-level description.
      await writeManifest(home, "m", "toplevel", "v1", {
        name: "toplevel",
        description: "from top level",
      });
      // Neither description present → null.
      await writeManifest(home, "m", "nodesc", "v1", { name: "nodesc" });
      // Invalid JSON → plugin excluded, does not throw.
      await writeManifest(home, "m", "broken", "v1", "{ not valid json ");

      const entries = await runRegistry(home);
      const map = byName(entries);
      expect([...map.keys()].sort()).toEqual(["nodesc", "toplevel"]);
      expect(map.get("toplevel")!.description).toBe("from top level");
      expect(map.get("nodesc")!.description).toBeNull();
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });

  it("returns an empty list when config.toml is missing", async () => {
    const home = await makeCodexHome();
    try {
      await writeManifest(home, "openai-curated", "github", "v1", ifaceManifest("github", "gh"));
      await expect(runRegistry(home)).resolves.toEqual([]);
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });

  it("does not throw when the plugins cache is absent", async () => {
    const home = await makeCodexHome();
    try {
      await write(
        path.join(home, "config.toml"),
        [`[plugins."github@openai-curated"]`, `enabled = true`].join("\n")
      );
      await expect(runRegistry(home)).resolves.toEqual([]);
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });
});

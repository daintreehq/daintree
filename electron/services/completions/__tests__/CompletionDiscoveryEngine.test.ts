import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { CompletionDiscoveryEngine } from "../CompletionDiscoveryEngine.js";
import { adaptBuiltinSlashCommands } from "../staticCatalog.js";
import { resolveLocationDir, type PathResolveContext } from "../completionPathTemplates.js";
import type { CompletionLocation } from "../../../../shared/types/completionSources.js";

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "daintree-completions-"));
}

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, contents, "utf8");
}

function overrideHome(dir: string): Record<string, string | undefined> {
  const keys = [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "CLAUDE_CONFIG_DIR",
    "GEMINI_CONFIG_DIR",
    "CODEX_HOME",
  ];
  const prev: Record<string, string | undefined> = {};
  for (const key of keys) prev[key] = process.env[key];
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.GEMINI_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  return prev;
}

function restoreHome(prev: Record<string, string | undefined>): void {
  for (const [key, val] of Object.entries(prev)) {
    if (val !== undefined) process.env[key] = val;
    else delete process.env[key];
  }
}

const otherPlatform: NodeJS.Platform = process.platform === "linux" ? "darwin" : "linux";

function ctx(overrides: Partial<PathResolveContext> = {}): PathResolveContext {
  return {
    home: "/home/tester",
    projectRoot: "/proj",
    platform: process.platform,
    env: {},
    ...overrides,
  };
}

describe("adaptBuiltinSlashCommands", () => {
  it("stamps trigger '/' and kind 'command' on every built-in", () => {
    const stamped = adaptBuiltinSlashCommands("claude");
    expect(stamped.length).toBeGreaterThan(0);
    for (const cmd of stamped) {
      expect(cmd.trigger).toBe("/");
      expect(cmd.kind).toBe("command");
      expect(cmd.scope).toBe("built-in");
    }
  });
});

describe("resolveLocationDir", () => {
  const home = "/home/tester";

  it("resolves a project-rooted location", () => {
    const loc: CompletionLocation = {
      id: "p",
      scope: "project",
      base: { type: "projectRoot" },
      segments: [".claude", "commands"],
      locationPrecedence: 0,
    };
    expect(resolveLocationDir(loc, ctx({ projectRoot: "/proj" }))).toBe(
      path.join("/proj", ".claude", "commands")
    );
  });

  it("returns null when a project-rooted location has no project root", () => {
    const loc: CompletionLocation = {
      id: "p",
      scope: "project",
      base: { type: "projectRoot" },
      segments: [".claude", "commands"],
      locationPrecedence: 0,
    };
    expect(resolveLocationDir(loc, ctx({ projectRoot: undefined }))).toBeNull();
  });

  it("prefers the config-dir env value over the home fallback", () => {
    const loc: CompletionLocation = {
      id: "u",
      scope: "user",
      base: {
        type: "env",
        name: "CLAUDE_CONFIG_DIR",
        fallback: { type: "homeRelative", segments: [".claude"] },
      },
      segments: ["commands"],
      locationPrecedence: 0,
    };
    expect(resolveLocationDir(loc, ctx({ env: { CLAUDE_CONFIG_DIR: "/custom/claude" } }))).toBe(
      path.join("/custom/claude", "commands")
    );
    expect(resolveLocationDir(loc, ctx({ home, env: {} }))).toBe(
      path.join(home, ".claude", "commands")
    );
  });

  it("falls back to ~/.config for XDG when unset", () => {
    const loc: CompletionLocation = {
      id: "x",
      scope: "user",
      base: {
        type: "env",
        name: "XDG_CONFIG_HOME",
        fallback: { type: "homeRelative", segments: [".config"] },
      },
      segments: ["claude", "commands"],
      locationPrecedence: 1,
    };
    expect(resolveLocationDir(loc, ctx({ home, env: {} }))).toBe(
      path.join(home, ".config", "claude", "commands")
    );
    expect(resolveLocationDir(loc, ctx({ env: { XDG_CONFIG_HOME: "/xdg" } }))).toBe(
      path.join("/xdg", "claude", "commands")
    );
  });

  it("gates a location to its declared platforms", () => {
    const base: CompletionLocation = {
      id: "g",
      scope: "global",
      base: { type: "absolute", path: "/etc" },
      segments: ["claude", "commands"],
      locationPrecedence: 0,
    };
    expect(resolveLocationDir({ ...base, platforms: [process.platform] }, ctx())).toBe(
      path.join("/etc", "claude", "commands")
    );
    expect(resolveLocationDir({ ...base, platforms: [otherPlatform] }, ctx())).toBeNull();
  });

  it("rejects unsafe segments (traversal, separators, absolute)", () => {
    const mk = (segments: string[]): CompletionLocation => ({
      id: "s",
      scope: "user",
      base: { type: "homeRelative", segments: [".claude"] },
      segments,
      locationPrecedence: 0,
    });
    expect(resolveLocationDir(mk([".."]), ctx({ home }))).toBeNull();
    expect(resolveLocationDir(mk(["a/b"]), ctx({ home }))).toBeNull();
    expect(resolveLocationDir(mk(["/abs"]), ctx({ home }))).toBeNull();
    expect(resolveLocationDir(mk(["ok"]), ctx({ home }))).toBe(path.join(home, ".claude", "ok"));
  });
});

describe("CompletionDiscoveryEngine", () => {
  it("reuses one physical scan of shared .agents/skills across agents", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const prev = overrideHome(homeRoot);
    const engine = new CompletionDiscoveryEngine();

    const readdirSpy = vi.spyOn(fsp, "readdir");
    const sharedDir = path.join(projectRoot, ".agents", "skills");

    try {
      await fsp.mkdir(path.join(projectRoot, ".git"));
      await writeFile(
        path.join(sharedDir, "stabilize", "SKILL.md"),
        `---
description: "Shared stabilize skill"
---

Body.
`
      );

      const claude = await engine.list("claude", projectRoot);
      const codex = await engine.list("codex", projectRoot);

      // Claude exposes it as /stabilize, Codex as $stabilize — same physical dir.
      expect(claude.find((c) => c.label === "/stabilize")?.kind).toBe("skill");
      expect(codex.find((c) => c.label === "$stabilize")?.kind).toBe("skill");

      const sharedReads = readdirSpy.mock.calls.filter(
        (call) => path.resolve(String(call[0])) === path.resolve(sharedDir)
      );
      expect(sharedReads).toHaveLength(1);
    } finally {
      readdirSpy.mockRestore();
      restoreHome(prev);
      await fsp.rm(homeRoot, { recursive: true, force: true });
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("caches results and re-scans only after clearCache", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const prev = overrideHome(homeRoot);
    const engine = new CompletionDiscoveryEngine();
    const commandsDir = path.join(projectRoot, ".claude", "commands");
    const readdirSpy = vi.spyOn(fsp, "readdir");

    try {
      await fsp.mkdir(path.join(projectRoot, ".git"));
      await writeFile(
        path.join(commandsDir, "foo.md"),
        `---
description: "Foo"
---

Body.
`
      );

      await engine.list("claude", projectRoot);
      const readsAfterFirst = readdirSpy.mock.calls.filter(
        (call) => path.resolve(String(call[0])) === path.resolve(commandsDir)
      ).length;
      expect(readsAfterFirst).toBe(1);

      await engine.list("claude", projectRoot);
      const readsAfterSecond = readdirSpy.mock.calls.filter(
        (call) => path.resolve(String(call[0])) === path.resolve(commandsDir)
      ).length;
      expect(readsAfterSecond).toBe(1); // served from cache

      engine.clearCache();
      await engine.list("claude", projectRoot);
      const readsAfterClear = readdirSpy.mock.calls.filter(
        (call) => path.resolve(String(call[0])) === path.resolve(commandsDir)
      ).length;
      expect(readsAfterClear).toBe(2); // cache dropped → rescanned
    } finally {
      readdirSpy.mockRestore();
      restoreHome(prev);
      await fsp.rm(homeRoot, { recursive: true, force: true });
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("returns [] for an agent with no declared completion sources", async () => {
    const engine = new CompletionDiscoveryEngine();
    expect(await engine.list("opencode")).toEqual([]);
  });

  it("orders results by trigger (/ before $) then label", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const prev = overrideHome(homeRoot);
    const engine = new CompletionDiscoveryEngine();

    try {
      await fsp.mkdir(path.join(projectRoot, ".git"));
      await writeFile(
        path.join(projectRoot, ".agents", "skills", "zzz", "SKILL.md"),
        `---
description: "Z skill"
---

Body.
`
      );

      const codex = await engine.list("codex", projectRoot);
      const slashIdx = codex.findIndex((c) => c.trigger === "/");
      const dollarIdx = codex.findIndex((c) => c.trigger === "$");
      expect(slashIdx).toBeGreaterThanOrEqual(0);
      expect(dollarIdx).toBeGreaterThan(slashIdx);
    } finally {
      restoreHome(prev);
      await fsp.rm(homeRoot, { recursive: true, force: true });
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

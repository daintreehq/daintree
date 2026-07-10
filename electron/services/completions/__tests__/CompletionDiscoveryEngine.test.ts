import { describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { CompletionDiscoveryEngine } from "../CompletionDiscoveryEngine.js";
import { adaptBuiltinSlashCommands } from "../staticCatalog.js";
import { resolveLocationDir, type PathResolveContext } from "../completionPathTemplates.js";
import type {
  CompletionLocation,
  CompletionPlatform,
} from "../../../../shared/types/completionSources.js";

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

const currentPlatform: CompletionPlatform =
  process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const otherPlatform: CompletionPlatform = currentPlatform === "linux" ? "darwin" : "linux";

function ctx(overrides: Partial<PathResolveContext> = {}): PathResolveContext {
  return {
    home: "/home/tester",
    projectRoot: "/proj",
    platform: process.platform,
    env: {},
    ...overrides,
  };
}

function readdirCallsFor(spy: { mock: { calls: unknown[][] } }, dir: string): number {
  const target = path.resolve(dir);
  return spy.mock.calls.filter((call) => path.resolve(String(call[0])) === target).length;
}

describe("adaptBuiltinSlashCommands", () => {
  it("stamps the source trigger and kind 'command' on every built-in", () => {
    const stamped = adaptBuiltinSlashCommands("claude", "/");
    expect(stamped.length).toBeGreaterThan(0);
    for (const cmd of stamped) {
      expect(cmd.trigger).toBe("/");
      expect(cmd.kind).toBe("command");
      expect(cmd.scope).toBe("built-in");
    }
  });

  it("honors the passed trigger rather than hardcoding '/'", () => {
    // Guards the source.trigger stamping (a static source could declare a
    // non-slash trigger); a hardcoded "/" would fail this.
    for (const cmd of adaptBuiltinSlashCommands("codex", "$")) {
      expect(cmd.trigger).toBe("$");
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

  it("prefers the config-dir env value (resolved) over the home fallback", () => {
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
      path.join(path.resolve("/custom/claude"), "commands")
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
      path.join(path.resolve("/xdg"), "claude", "commands")
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
    expect(resolveLocationDir({ ...base, platforms: [currentPlatform] }, ctx())).toBe(
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
    for (const bad of [[".."], ["."], [""], ["a/b"], ["a\\b"], ["..\\escape"], ["/abs"]]) {
      expect(resolveLocationDir(mk(bad), ctx({ home }))).toBeNull();
    }
    expect(resolveLocationDir(mk(["ok"]), ctx({ home }))).toBe(path.join(home, ".claude", "ok"));
  });

  it("rejects unsafe segments in a homeRelative base too", () => {
    const loc: CompletionLocation = {
      id: "b",
      scope: "user",
      base: { type: "homeRelative", segments: ["..", "escape"] },
      segments: ["skills"],
      locationPrecedence: 0,
    };
    expect(resolveLocationDir(loc, ctx({ home }))).toBeNull();
  });
});

describe("CompletionDiscoveryEngine", () => {
  it("caches results and re-scans only after clearCache (result cache, not scan I/O)", async () => {
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
      expect(readdirCallsFor(readdirSpy, commandsDir)).toBe(1);

      // Second call is served from the result cache — no compute(), no scan.
      await engine.list("claude", projectRoot);
      expect(readdirCallsFor(readdirSpy, commandsDir)).toBe(1);

      // clearCache drops the result → the next call recomputes and rescans.
      engine.clearCache();
      await engine.list("claude", projectRoot);
      expect(readdirCallsFor(readdirSpy, commandsDir)).toBe(2);
    } finally {
      readdirSpy.mockRestore();
      restoreHome(prev);
      await fsp.rm(homeRoot, { recursive: true, force: true });
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("returns cloned results so a caller cannot mutate the cache", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const prev = overrideHome(homeRoot);
    const engine = new CompletionDiscoveryEngine();

    try {
      await fsp.mkdir(path.join(projectRoot, ".git"));

      const first = await engine.list("claude", projectRoot);
      const help = first.find((c) => c.label === "/help");
      expect(help).toBeDefined();
      help!.description = "MUTATED";

      const second = await engine.list("claude", projectRoot);
      expect(second.find((c) => c.label === "/help")?.description).not.toBe("MUTATED");
    } finally {
      restoreHome(prev);
      await fsp.rm(homeRoot, { recursive: true, force: true });
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("returns [] for an agent with no declared completion sources", async () => {
    const engine = new CompletionDiscoveryEngine();
    expect(await engine.list("opencode")).toEqual([]);
  });

  it("orders results by trigger (/ before $) then label within each trigger", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const prev = overrideHome(homeRoot);
    const engine = new CompletionDiscoveryEngine();

    try {
      await fsp.mkdir(path.join(projectRoot, ".git"));
      for (const name of ["zebra", "alpha"]) {
        await writeFile(
          path.join(projectRoot, ".agents", "skills", name, "SKILL.md"),
          `---
description: "${name} skill"
---

Body.
`
        );
      }

      const codex = await engine.list("codex", projectRoot);
      const lastSlash = codex.map((c) => c.trigger).lastIndexOf("/");
      const firstDollar = codex.findIndex((c) => c.trigger === "$");
      expect(lastSlash).toBeGreaterThanOrEqual(0);
      expect(firstDollar).toBeGreaterThan(lastSlash);

      // $ partition is label-sorted: $alpha before $zebra.
      const dollarLabels = codex.filter((c) => c.trigger === "$").map((c) => c.label);
      expect(dollarLabels).toEqual([...dollarLabels].sort((a, b) => a.localeCompare(b)));
      expect(dollarLabels).toContain("$alpha");
      expect(dollarLabels).toContain("$zebra");
    } finally {
      restoreHome(prev);
      await fsp.rm(homeRoot, { recursive: true, force: true });
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

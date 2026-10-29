import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { CompletionDiscoveryEngine } from "../CompletionDiscoveryEngine.js";
import { adaptBuiltinSlashCommands } from "../staticCatalog.js";
import { resolveLocationDir, type PathResolveContext } from "../completionPathTemplates.js";
import type { SlashCommand } from "../../../../shared/types/index.js";
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

  it("keeps a built-in's declared kind instead of stamping 'command'", () => {
    const kinds = new Map(adaptBuiltinSlashCommands("antigravity", "/").map((c) => [c.id, c.kind]));
    expect(kinds.get("antigravity-guide")).toBe("skill");
    expect(kinds.get("usage")).toBe("command");
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
  it("reuses results within the TTL and re-scans after clearCache (result cache, not scan I/O)", async () => {
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

  it("surfaces enabled Codex plugins as $-kind:plugin, and a user skill wins a label collision", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const prev = overrideHome(homeRoot);
    const engine = new CompletionDiscoveryEngine();
    const codexHome = path.join(homeRoot, ".codex");

    try {
      await fsp.mkdir(path.join(projectRoot, ".git"));
      await writeFile(
        path.join(codexHome, "config.toml"),
        [
          `[plugins."github@openai-curated"]`,
          `enabled = true`,
          ``,
          `[plugins."gmail@openai-curated"]`,
          `enabled = true`,
        ].join("\n")
      );
      const manifest = (name: string, short: string) =>
        JSON.stringify({
          name,
          description: `${name} top`,
          interface: { shortDescription: short },
        });
      await writeFile(
        path.join(
          codexHome,
          "plugins",
          "cache",
          "openai-curated",
          "github",
          "v1",
          ".codex-plugin",
          "plugin.json"
        ),
        manifest("github", "Triage PRs and CI")
      );
      await writeFile(
        path.join(
          codexHome,
          "plugins",
          "cache",
          "openai-curated",
          "gmail",
          "v1",
          ".codex-plugin",
          "plugin.json"
        ),
        manifest("gmail", "Read and manage Gmail")
      );
      // A user skill named `github` collides with the plugin's `$github` token.
      await writeFile(
        path.join(codexHome, "skills", "github", "SKILL.md"),
        `---
description: "user github skill"
---

Body.
`
      );

      const codex = await engine.list("codex", projectRoot);

      const gmail = codex.find((c) => c.label === "$gmail");
      expect(gmail).toMatchObject({
        kind: "plugin",
        trigger: "$",
        scope: "user",
        description: "Read and manage Gmail",
      });

      // Dedupe by trigger+label: plugin sourcePrecedence (10) < skill (20), so
      // the user's own skill wins the `$github` label.
      const github = codex.filter((c) => c.label === "$github");
      expect(github).toHaveLength(1);
      expect(github[0]).toMatchObject({ kind: "skill", description: "user github skill" });
    } finally {
      restoreHome(prev);
      await fsp.rm(homeRoot, { recursive: true, force: true });
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("surfaces personal Codex skills from ~/.agents/skills, outranking $CODEX_HOME/skills", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const codexHome = await makeTempDir();
    const prev = overrideHome(homeRoot);
    process.env.CODEX_HOME = codexHome;
    const engine = new CompletionDiscoveryEngine();
    const skill = (description: string) => `---
description: "${description}"
---

Body.
`;

    try {
      await fsp.mkdir(path.join(projectRoot, ".git"));
      await writeFile(
        path.join(homeRoot, ".agents", "skills", "personal", "SKILL.md"),
        skill("personal skill")
      );
      await writeFile(
        path.join(codexHome, "skills", "installed", "SKILL.md"),
        skill("installed skill")
      );
      await writeFile(
        path.join(homeRoot, ".agents", "skills", "shared", "SKILL.md"),
        skill("agents shared")
      );
      await writeFile(
        path.join(codexHome, "skills", "shared", "SKILL.md"),
        skill("codex-home shared")
      );
      await writeFile(
        path.join(homeRoot, ".agents", "skills", "proj", "SKILL.md"),
        skill("agents proj")
      );
      await writeFile(
        path.join(projectRoot, ".agents", "skills", "proj", "SKILL.md"),
        skill("project proj")
      );
      // `~/.agents` is not relocated by CODEX_HOME.
      await writeFile(
        path.join(codexHome, ".agents", "skills", "decoy", "SKILL.md"),
        skill("decoy skill")
      );

      const codex = await engine.list("codex", projectRoot);
      const byLabel = (label: string) => codex.filter((c) => c.label === label);

      expect(byLabel("$personal")).toEqual([
        expect.objectContaining({ kind: "skill", scope: "user", description: "personal skill" }),
      ]);
      expect(byLabel("$installed")).toEqual([
        expect.objectContaining({ scope: "user", description: "installed skill" }),
      ]);
      expect(byLabel("$shared")).toEqual([
        expect.objectContaining({
          scope: "user",
          description: "agents shared",
          sourcePath: path.join(homeRoot, ".agents", "skills", "shared", "SKILL.md"),
        }),
      ]);
      expect(byLabel("$proj")).toEqual([
        expect.objectContaining({ scope: "project", description: "project proj" }),
      ]);
      expect(byLabel("$decoy")).toEqual([]);
    } finally {
      restoreHome(prev);
      await fsp.rm(homeRoot, { recursive: true, force: true });
      await fsp.rm(projectRoot, { recursive: true, force: true });
      await fsp.rm(codexHome, { recursive: true, force: true });
    }
  });

  it("reads both ~/.agents/skills and ~/.codex/skills when CODEX_HOME is unset", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const prev = overrideHome(homeRoot);
    const engine = new CompletionDiscoveryEngine();
    const skill = (description: string) => `---
description: "${description}"
---

Body.
`;

    try {
      await fsp.mkdir(path.join(projectRoot, ".git"));
      await writeFile(
        path.join(homeRoot, ".agents", "skills", "personal", "SKILL.md"),
        skill("personal skill")
      );
      await writeFile(
        path.join(homeRoot, ".codex", "skills", "installed", "SKILL.md"),
        skill("installed skill")
      );

      const codex = await engine.list("codex", projectRoot);
      const labels = codex.filter((c) => c.trigger === "$").map((c) => c.label);
      expect(labels).toContain("$personal");
      expect(labels).toContain("$installed");
    } finally {
      restoreHome(prev);
      await fsp.rm(homeRoot, { recursive: true, force: true });
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("CompletionDiscoveryEngine: Antigravity", () => {
  // agy lists a skill under its frontmatter `name`, never its folder name.
  const skill = (name: string, description: string) => `---
name: ${name}
description: "${description}"
---

Body.
`;

  it("lists agy's built-ins and the skills in every folder agy reads, and nothing it ignores", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const prev = overrideHome(homeRoot);
    const engine = new CompletionDiscoveryEngine();

    try {
      await fsp.mkdir(path.join(projectRoot, ".git"));
      const read: Array<[string[], string]> = [
        [[projectRoot, ".agents", "skills"], "proj-agents"],
        [[projectRoot, ".agent", "skills"], "proj-agent"],
        [[homeRoot, ".gemini", "config", "skills"], "user-config"],
        [[homeRoot, ".gemini", "antigravity-cli", "skills"], "user-cli"],
        [[homeRoot, ".gemini", "skills"], "user-gemini"],
      ];
      const ignored: Array<[string[], string]> = [
        [[projectRoot, ".gemini", "skills"], "proj-gemini"],
        [[homeRoot, ".agents", "skills"], "user-agents"],
        [[homeRoot, ".gemini", "antigravity-cli", "builtin", "skills"], "automation"],
      ];
      for (const [dir, name] of [...read, ...ignored]) {
        await writeFile(path.join(...dir, `${name}_dir`, "SKILL.md"), skill(name, `${name} skill`));
      }
      await writeFile(
        path.join(projectRoot, ".gemini", "commands", "deploy.toml"),
        `description = "TOML command"\n`
      );
      await writeFile(
        path.join(projectRoot, ".agents", "workflows", "release.md"),
        `---\ndescription: "Legacy workflow"\n---\n`
      );

      const agy = await engine.list("antigravity", projectRoot);
      const byLabel = new Map(agy.map((c) => [c.label, c]));

      for (const [dir, name] of read) {
        expect(byLabel.get(`/${name}`), name).toMatchObject({
          kind: "skill",
          trigger: "/",
          scope: dir[0] === projectRoot ? "project" : "user",
          description: `${name} skill`,
        });
      }
      for (const [, name] of ignored) expect(byLabel.has(`/${name}`), name).toBe(false);
      expect(byLabel.has("/deploy")).toBe(false);
      expect(byLabel.has("/release")).toBe(false);

      expect(byLabel.get("/usage")).toMatchObject({
        scope: "built-in",
        kind: "command",
        aliases: ["quota"],
      });
      expect(byLabel.get("/agy-customizations")).toMatchObject({ kind: "skill" });
      expect(agy.every((c) => c.trigger === "/")).toBe(true);
    } finally {
      restoreHome(prev);
      await fsp.rm(homeRoot, { recursive: true, force: true });
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("lets a project skill win over a user skill of the same name", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const prev = overrideHome(homeRoot);
    const engine = new CompletionDiscoveryEngine();

    try {
      await fsp.mkdir(path.join(projectRoot, ".git"));
      await writeFile(
        path.join(homeRoot, ".gemini", "skills", "ship", "SKILL.md"),
        skill("ship", "user ship")
      );
      await writeFile(
        path.join(projectRoot, ".agents", "skills", "ship", "SKILL.md"),
        skill("ship", "project ship")
      );

      const ship = (await engine.list("antigravity", projectRoot)).filter(
        (c) => c.label === "/ship"
      );
      expect(ship).toEqual([
        expect.objectContaining({ scope: "project", description: "project ship" }),
      ]);
    } finally {
      restoreHome(prev);
      await fsp.rm(homeRoot, { recursive: true, force: true });
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("CompletionDiscoveryEngine result-cache residency", () => {
  type Compute = (...args: unknown[]) => Promise<SlashCommand[]>;
  let base: string;
  let now: number;

  const cacheOf = (engine: CompletionDiscoveryEngine) =>
    (engine as unknown as { resultCache: Map<string, { expires: number }> }).resultCache;
  const cacheSize = (engine: CompletionDiscoveryEngine) => cacheOf(engine).size;

  /** Settled residency cap, discovered by filling an engine sequentially. */
  async function discoverCap(): Promise<number> {
    const engine = new CompletionDiscoveryEngine();
    stubCompute(engine);
    let i = 0;
    let size = -1;
    while (i < 500 && cacheSize(engine) !== size) {
      size = cacheSize(engine);
      await engine.list("claude", project(i++));
    }
    expect(size).toBeLessThan(500);
    return size;
  }

  function stubCompute(engine: CompletionDiscoveryEngine, impl?: Compute) {
    const spy = vi.fn<Compute>(impl ?? (async () => []));
    (engine as unknown as { compute: Compute }).compute = spy;
    return spy;
  }

  function deferred() {
    let resolve!: (value: SlashCommand[]) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<SlashCommand[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // Project paths that need not exist: resolveProjectRoot falls back to the
  // resolved input when no .git is found, so each index is a distinct key.
  const project = (i: number) => path.join(base, `p${i}`);

  beforeEach(async () => {
    base = await makeTempDir();
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(base, { recursive: true, force: true });
  });

  it("sweeps expired entries for keys that are never revisited", async () => {
    const engine = new CompletionDiscoveryEngine();
    const compute = stubCompute(engine);

    for (let i = 0; i < 20; i++) await engine.list("claude", project(i));
    expect(cacheSize(engine)).toBe(20);

    now += 60_000;
    await engine.list("claude", project(0));
    expect(cacheSize(engine)).toBe(1);
    expect(compute).toHaveBeenCalledTimes(21);
  });

  it("sweeps expired entries on a warm hit, not only on a miss", async () => {
    const engine = new CompletionDiscoveryEngine();
    const compute = stubCompute(engine);

    await engine.list("claude", project(0));
    now += 20_000;
    await engine.list("claude", project(1));
    now += 15_000;
    // project(0) has expired; project(1) is still warm and is served from cache.
    await engine.list("claude", project(1));
    expect(compute).toHaveBeenCalledTimes(2);
    expect(cacheSize(engine)).toBe(1);
  });

  it("reuses within the TTL and rescans after expiry", async () => {
    const engine = new CompletionDiscoveryEngine();
    const compute = stubCompute(engine);

    await engine.list("claude", project(0));
    const [{ expires }] = [...cacheOf(engine).values()];
    now = expires - 1;
    await engine.list("claude", project(0));
    expect(compute).toHaveBeenCalledTimes(1);
    now = expires;
    await engine.list("claude", project(0));
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("caps residency, evicting the least recently used key", async () => {
    const engine = new CompletionDiscoveryEngine();
    const compute = stubCompute(engine);

    await engine.list("claude", project(0));
    let size = cacheSize(engine);
    let i = 1;
    // Fill until the cap stops growth, touching project(0) each time so it stays
    // most recently used.
    while (i < 500) {
      await engine.list("claude", project(i++));
      await engine.list("claude", project(0));
      if (cacheSize(engine) === size) break;
      size = cacheSize(engine);
    }
    const cap = cacheSize(engine);
    expect(cap).toBeLessThan(500);
    const callsBefore = compute.mock.calls.length;

    // project(0) survived as the most recent; project(1) was the oldest untouched.
    await engine.list("claude", project(0));
    expect(compute.mock.calls.length).toBe(callsBefore);
    await engine.list("claude", project(1));
    expect(compute.mock.calls.length).toBe(callsBefore + 1);
    expect(cacheSize(engine)).toBe(cap);
  });

  it("never evicts a pending scan, so concurrent callers still coalesce", async () => {
    const engine = new CompletionDiscoveryEngine();
    const pending = deferred();
    const compute = stubCompute(engine, async () => []);
    compute.mockImplementationOnce(() => pending.promise);

    const first = engine.list("claude", project(0));
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    // Flood well past the cap; the pending entry must survive the trim.
    for (let i = 1; i <= 200; i++) await engine.list("claude", project(i));
    expect(cacheSize(engine)).toBeLessThan(200);
    now += 1_000;
    const second = engine.list("claude", project(0));

    pending.resolve([{ id: "x", label: "/x" } as SlashCommand]);
    expect(await first).toEqual([{ id: "x", label: "/x" }]);
    expect(await second).toEqual([{ id: "x", label: "/x" }]);
    expect(compute).toHaveBeenCalledTimes(201);
  });

  it("contracts a pending overshoot back to the cap once scans settle", async () => {
    const engine = new CompletionDiscoveryEngine();
    const scans: Array<ReturnType<typeof deferred>> = [];
    stubCompute(engine, () => {
      const d = deferred();
      scans.push(d);
      return d.promise;
    });

    const calls: Array<Promise<SlashCommand[]>> = [];
    for (let i = 0; i < 100; i++) calls.push(engine.list("claude", project(i)));
    await vi.waitFor(() => expect(scans).toHaveLength(100));
    expect(cacheSize(engine)).toBe(100);

    for (const scan of scans) scan.resolve([]);
    await Promise.all(calls);
    expect(cacheSize(engine)).toBe(await discoverCap());
  });

  it("replaces an expired pending scan, and the stale one cannot disturb its replacement", async () => {
    const engine = new CompletionDiscoveryEngine();
    const stale = deferred();
    const fresh = deferred();
    const compute = stubCompute(engine);
    compute.mockImplementationOnce(() => stale.promise);
    compute.mockImplementationOnce(() => fresh.promise);

    const staleCall = engine.list("claude", project(0));
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    now += 60_000;
    const freshCall = engine.list("claude", project(0));
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(2));

    stale.reject(new Error("stale"));
    await expect(staleCall).rejects.toThrow("stale");
    fresh.resolve([]);
    await freshCall;

    expect(cacheSize(engine)).toBe(1);
    await engine.list("claude", project(0));
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keys on the environment revision", async () => {
    const engine = new CompletionDiscoveryEngine();
    const compute = stubCompute(engine);
    const prev = process.env.CLAUDE_CONFIG_DIR;

    try {
      process.env.CLAUDE_CONFIG_DIR = path.join(base, "config-a");
      await engine.list("claude", project(0));
      process.env.CLAUDE_CONFIG_DIR = path.join(base, "config-b");
      await engine.list("claude", project(0));
      expect(compute).toHaveBeenCalledTimes(2);
      await engine.list("claude", project(0));
      expect(compute).toHaveBeenCalledTimes(2);
      expect(cacheSize(engine)).toBe(2);
    } finally {
      if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev;
      else delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it("does not cache a lookup that straddled clearCache", async () => {
    const engine = new CompletionDiscoveryEngine();
    const compute = stubCompute(engine);

    // list() reads sources, then awaits project-root resolution; the clear
    // lands in that gap.
    const call = engine.list("claude", project(0));
    engine.clearCache();
    expect(await call).toEqual([]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(cacheSize(engine)).toBe(0);
  });

  it("evicts a failed scan so the next call retries", async () => {
    const engine = new CompletionDiscoveryEngine();
    const compute = stubCompute(engine);
    compute.mockRejectedValueOnce(new Error("boom"));

    await expect(engine.list("claude", project(0))).rejects.toThrow("boom");
    expect(cacheSize(engine)).toBe(0);
    await engine.list("claude", project(0));
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("does not let a scan invalidated by clearCache touch the newer entry", async () => {
    const engine = new CompletionDiscoveryEngine();
    const stale = deferred();
    const fresh = deferred();
    const compute = stubCompute(engine);
    compute.mockImplementationOnce(() => stale.promise);
    compute.mockImplementationOnce(() => fresh.promise);

    const staleCall = engine.list("claude", project(0));
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    engine.clearCache();
    const freshCall = engine.list("claude", project(0));
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(2));

    // The stale scan failing must neither delete the newer entry nor mark it
    // settled (which would expose it to the sweep while still pending).
    stale.reject(new Error("stale"));
    await expect(staleCall).rejects.toThrow("stale");
    expect(cacheSize(engine)).toBe(1);
    now += 60_000;
    await engine.list("claude", project(1));
    expect(cacheSize(engine)).toBe(2);

    fresh.resolve([]);
    await freshCall;
  });
});

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTerminalEnv, computeSpawnContext } from "../terminalSpawn.js";
import type { PtySpawnOptions } from "../types.js";

const baseOptions: PtySpawnOptions = {
  cwd: "/repo",
  cols: 80,
  rows: 24,
};

describe("buildTerminalEnv NODE_COMPILE_CACHE injection", () => {
  let originalUserData: string | undefined;
  let originalApiKey: string | undefined;
  let originalCompileCache: string | undefined;

  beforeEach(() => {
    originalUserData = process.env.DAINTREE_USER_DATA;
    // Avoid leaking real credentials from the host shell into spawn under test.
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    // buildTerminalEnv inherits from process.env, so a NODE_COMPILE_CACHE
    // set by the host shell (e.g. when running tests from inside Daintree)
    // would shadow the injection logic and fail assertions.
    originalCompileCache = process.env.NODE_COMPILE_CACHE;
    delete process.env.NODE_COMPILE_CACHE;
  });

  afterEach(() => {
    if (originalUserData === undefined) {
      delete process.env.DAINTREE_USER_DATA;
    } else {
      process.env.DAINTREE_USER_DATA = originalUserData;
    }
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
    if (originalCompileCache === undefined) {
      delete process.env.NODE_COMPILE_CACHE;
    } else {
      process.env.NODE_COMPILE_CACHE = originalCompileCache;
    }
  });

  it("injects NODE_COMPILE_CACHE for a Claude agent spawn", () => {
    process.env.DAINTREE_USER_DATA = "/tmp/test-userdata";
    const env = buildTerminalEnv(
      { ...baseOptions, launchAgentId: "claude" },
      "pane-1",
      "/bin/bash"
    );
    expect(env.NODE_COMPILE_CACHE).toBe(
      path.join("/tmp/test-userdata", "agent-compile-cache", "claude")
    );
  });

  it("injects NODE_COMPILE_CACHE for a Gemini agent spawn", () => {
    process.env.DAINTREE_USER_DATA = "/tmp/test-userdata";
    const env = buildTerminalEnv(
      { ...baseOptions, launchAgentId: "gemini" },
      "pane-1",
      "/bin/bash"
    );
    expect(env.NODE_COMPILE_CACHE).toBe(
      path.join("/tmp/test-userdata", "agent-compile-cache", "gemini")
    );
  });

  it("does NOT inject NODE_COMPILE_CACHE for Codex (Rust binary)", () => {
    process.env.DAINTREE_USER_DATA = "/tmp/test-userdata";
    const env = buildTerminalEnv({ ...baseOptions, launchAgentId: "codex" }, "pane-1", "/bin/bash");
    expect(env.NODE_COMPILE_CACHE).toBeUndefined();
  });

  it("does NOT inject NODE_COMPILE_CACHE for plain terminals (no launchAgentId)", () => {
    process.env.DAINTREE_USER_DATA = "/tmp/test-userdata";
    const env = buildTerminalEnv(baseOptions, "pane-1", "/bin/bash");
    expect(env.NODE_COMPILE_CACHE).toBeUndefined();
  });

  it("does NOT inject when DAINTREE_USER_DATA is missing", () => {
    delete process.env.DAINTREE_USER_DATA;
    const env = buildTerminalEnv(
      { ...baseOptions, launchAgentId: "claude" },
      "pane-1",
      "/bin/bash"
    );
    expect(env.NODE_COMPILE_CACHE).toBeUndefined();
  });

  it("respects an explicit NODE_COMPILE_CACHE override from intentionalEnv", () => {
    process.env.DAINTREE_USER_DATA = "/tmp/test-userdata";
    const env = buildTerminalEnv(
      {
        ...baseOptions,
        launchAgentId: "claude",
        env: { NODE_COMPILE_CACHE: "/custom/path" },
      },
      "pane-1",
      "/bin/bash"
    );
    expect(env.NODE_COMPILE_CACHE).toBe("/custom/path");
  });
});

describe("buildTerminalEnv colour hints", () => {
  let originalNoColor: string | undefined;
  let originalForceColor: string | undefined;

  beforeEach(() => {
    // buildTerminalEnv inherits from process.env, so a NO_COLOR or FORCE_COLOR
    // exported by the host shell would decide these assertions for us — the
    // exact ambient dependency this suite exists to pin down (#11118).
    originalNoColor = process.env.NO_COLOR;
    originalForceColor = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
  });

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = originalForceColor;
  });

  it("defaults FORCE_COLOR when neither colour variable is set", () => {
    const env = buildTerminalEnv(baseOptions, "pane-1", "/bin/bash");
    expect(env.FORCE_COLOR).toBeDefined();
  });

  it("does not inject FORCE_COLOR when NO_COLOR is inherited", () => {
    process.env.NO_COLOR = "1";
    const env = buildTerminalEnv(baseOptions, "pane-1", "/bin/bash");
    expect(env.FORCE_COLOR).toBeUndefined();
    expect(env.NO_COLOR).toBe("1");
  });

  it("treats an empty inherited NO_COLOR as set", () => {
    process.env.NO_COLOR = "";
    const env = buildTerminalEnv(baseOptions, "pane-1", "/bin/bash");
    expect(env.FORCE_COLOR).toBeUndefined();
  });

  it("does not inject FORCE_COLOR when NO_COLOR comes from intentionalEnv", () => {
    const env = buildTerminalEnv({ ...baseOptions, env: { NO_COLOR: "1" } }, "pane-1", "/bin/bash");
    expect(env.FORCE_COLOR).toBeUndefined();
    expect(env.NO_COLOR).toBe("1");
  });

  it("preserves an explicit FORCE_COLOR rather than rewriting it", () => {
    const env = buildTerminalEnv(
      { ...baseOptions, env: { FORCE_COLOR: "0" } },
      "pane-1",
      "/bin/bash"
    );
    expect(env.FORCE_COLOR).toBe("0");
  });

  it("leaves a user-supplied FORCE_COLOR/NO_COLOR pairing alone", () => {
    const env = buildTerminalEnv(
      { ...baseOptions, env: { FORCE_COLOR: "1", NO_COLOR: "1" } },
      "pane-1",
      "/bin/bash"
    );
    expect(env.FORCE_COLOR).toBe("1");
    expect(env.NO_COLOR).toBe("1");
  });

  it("still defaults FORCE_COLOR when only COLORTERM is inherited", () => {
    const env = buildTerminalEnv(
      { ...baseOptions, env: { COLORTERM: "24bit" } },
      "pane-1",
      "/bin/bash"
    );
    expect(env.FORCE_COLOR).toBeDefined();
    expect(env.COLORTERM).toBe("24bit");
  });
});

describe("buildTerminalEnv Windows PATH override", () => {
  const realPlatform = process.platform;
  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  };

  // Windows reports PATH as `Path`, so the env the pty-host inherited carries
  // that spelling while our override uses `PATH`. On a POSIX test host those
  // really are two variables, which is precisely what lets us reproduce the
  // Windows collision here: seed `Path` alongside the runner's own `PATH` and
  // `process.env` presents the same two-key shape a Windows process would.
  const STALE = "C:\\Windows";
  const FRESH = "C:\\Windows;C:\\Python313";
  const AMBIENT = ["Path", "COLORTERM", "colorterm", "Lang", "daintree_pane_id"] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of AMBIENT) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.Path = STALE;
  });

  afterEach(() => {
    setPlatform(realPlatform);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  /**
   * node-pty emits `Object.keys(env)` verbatim into the child's environment
   * block — no dedup, no case folding — so a stale `Path` sitting beside a
   * fresh `PATH` is two entries for one variable and the first one wins.
   * Counting keys by folded name is the assertion that the block a Windows
   * shell actually receives is unambiguous.
   */
  const foldedKeysNamed = (env: Record<string, string>, name: string) =>
    Object.keys(env).filter((key) => key.toUpperCase() === name);

  const foldedDuplicates = (env: Record<string, string>) => {
    const seen = new Set<string>();
    return Object.keys(env).filter((key) => {
      const folded = key.toUpperCase();
      if (seen.has(folded)) return true;
      seen.add(folded);
      return false;
    });
  };

  it("collapses the inherited Path onto the fresh PATH instead of emitting both", () => {
    setPlatform("win32");
    const env = buildTerminalEnv({ ...baseOptions, env: { PATH: FRESH } }, "p1", "powershell.exe");

    const keys = foldedKeysNamed(env, "PATH");
    expect(keys).toHaveLength(1);
    expect(env[keys[0]]).toBe(FRESH);
  });

  it("collapses an override spelled in any casing", () => {
    setPlatform("win32");
    const env = buildTerminalEnv({ ...baseOptions, env: { pAtH: FRESH } }, "p1", "powershell.exe");

    const keys = foldedKeysNamed(env, "PATH");
    expect(keys).toHaveLength(1);
    expect(env[keys[0]]).toBe(FRESH);
  });

  it("hands pty.spawn an env with no case-insensitive duplicate key at all", () => {
    setPlatform("win32");
    process.env.colorterm = "16bit";
    process.env.Lang = "C";
    process.env.daintree_pane_id = "spoofed";

    // computeSpawnContext, not buildTerminalEnv: this is the object that
    // reaches `pty.spawn`, after metadata, locale, colour and profiling have
    // all had their turn at writing into it.
    const { env } = computeSpawnContext("p1", {
      ...baseOptions,
      env: { PATH: FRESH, COLORTERM: "24bit", LANG: "en_US.UTF-8" },
    });

    expect(foldedDuplicates(env)).toEqual([]);
    expect(env[foldedKeysNamed(env, "PATH")[0]]).toBe(FRESH);
    expect(env[foldedKeysNamed(env, "DAINTREE_PANE_ID")[0]]).toBe("p1");
  });

  it("keeps Path and PATH distinct on POSIX, where they are different variables", () => {
    setPlatform("darwin");
    const env = buildTerminalEnv({ ...baseOptions, env: { PATH: "/opt/bin" } }, "p1", "/bin/bash");

    // Both survive, unfolded: on POSIX these name two unrelated variables and
    // collapsing them would silently drop one.
    expect(env.PATH).toBe("/opt/bin");
    expect(env.Path).toBe(STALE);
  });
});

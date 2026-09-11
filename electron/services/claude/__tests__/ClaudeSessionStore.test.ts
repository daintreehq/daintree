import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import type { AgentSessionRecord } from "../../../../shared/types/ipc/agentSessionHistory.js";
import type { ShellEnvironmentObservation } from "../../../setup/shellEnvironmentObservation.js";
import {
  __resetClaudeSessionStoreForTests,
  findUntouchedClaudeSession,
  isClaudeSessionWithoutTranscript,
  observeClaudeTranscript,
  rememberClaudePaneStore,
  resolvePaneClaudeProjectsRoot,
  type ClaudeStoreFs,
  type ClaudeStoreOptions,
} from "../ClaudeSessionStore.js";

const SESSION = "006fdfc0-67bf-4df0-ad82-48ebfe4df184";
const OTHER = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
const CWD = "/work/app";
const CWD_SLUG = "-work-app";
const SHELL = "/bin/zsh";

const realFs: ClaudeStoreFs = {
  lstat: (target) => lstat(target),
  readdir: (target) => readdir(target),
};

let configDir: string;
let projectsRoot: string;

beforeEach(async () => {
  __resetClaudeSessionStoreForTests();
  configDir = await mkdtemp(path.join(os.tmpdir(), "claude-session-store-"));
  projectsRoot = path.join(configDir, "projects");
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

/** A POSIX machine whose probed login shell points Claude at `configDir`, unless told otherwise. */
function machine(observation?: ShellEnvironmentObservation | null): ClaudeStoreOptions {
  const observed =
    observation === undefined
      ? { shell: SHELL, env: { CLAUDE_CONFIG_DIR: configDir } }
      : (observation ?? undefined);
  return { platform: "linux", env: { SHELL }, readShellObservation: () => observed };
}

async function writeTranscript(slug: string, sessionId: string): Promise<void> {
  const dir = path.join(projectsRoot, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
}

function countingFs(
  base: ClaudeStoreFs = realFs
): ClaudeStoreFs & { readdirCalls: string[]; lstatCalls: string[] } {
  const readdirCalls: string[] = [];
  const lstatCalls: string[] = [];
  return {
    readdirCalls,
    lstatCalls,
    lstat: (target) => {
      lstatCalls.push(target);
      return base.lstat(target);
    },
    readdir: (target) => {
      readdirCalls.push(target);
      return base.readdir(target);
    },
  };
}

describe("resolvePaneClaudeProjectsRoot", () => {
  it("follows the store the probed profile points panes at", () => {
    expect(resolvePaneClaudeProjectsRoot({}, machine())).toBe(projectsRoot);
  });

  it("uses the default store when the probed profile leaves it unset", () => {
    expect(resolvePaneClaudeProjectsRoot({}, machine({ shell: SHELL, env: {} }))).toBe(
      path.join(os.homedir(), ".claude", "projects")
    );
  });

  it("accepts a pane that names the probed shell itself", () => {
    expect(resolvePaneClaudeProjectsRoot({ shell: SHELL }, { ...machine(), env: {} })).toBe(
      projectsRoot
    );
  });

  it("is unknown before the shell has been probed", () => {
    expect(resolvePaneClaudeProjectsRoot({}, machine(null))).toBeNull();
  });

  it("is unknown for a pane launching a different shell than the one probed", () => {
    expect(resolvePaneClaudeProjectsRoot({ shell: "/bin/bash" }, machine())).toBeNull();
  });

  it("accepts bash as well as zsh, the shells a pane starts as a login shell", () => {
    const bash = "/opt/homebrew/bin/bash";
    expect(
      resolvePaneClaudeProjectsRoot(
        {},
        { ...machine({ shell: bash, env: { CLAUDE_CONFIG_DIR: configDir } }), env: { SHELL: bash } }
      )
    ).toBe(projectsRoot);
  });

  it("is unknown for a shell a pane doesn't start as a login shell the way the probe does", () => {
    expect(
      resolvePaneClaudeProjectsRoot(
        {},
        { ...machine({ shell: "/bin/sh", env: {} }), env: { SHELL: "/bin/sh" } }
      )
    ).toBeNull();
  });

  it("is unknown for a pane that changes which startup files its shell reads", () => {
    for (const name of ["HOME", "ZDOTDIR", "ENV", "BASH_ENV"]) {
      expect(
        resolvePaneClaudeProjectsRoot({ env: { [name]: "/elsewhere" } }, machine())
      ).toBeNull();
    }
  });

  it("is unknown for a pane with its own CLAUDE_CONFIG_DIR, even an empty one", () => {
    for (const value of [configDir, ""]) {
      expect(
        resolvePaneClaudeProjectsRoot({ env: { CLAUDE_CONFIG_DIR: value } }, machine())
      ).toBeNull();
    }
  });

  it("is unknown when the profile sets an empty or relative store", () => {
    for (const value of ["", "relative/claude"]) {
      expect(
        resolvePaneClaudeProjectsRoot(
          {},
          machine({ shell: SHELL, env: { CLAUDE_CONFIG_DIR: value } })
        )
      ).toBeNull();
    }
  });

  it("is unknown on Windows, whose PowerShell and cmd profiles are never probed", () => {
    expect(resolvePaneClaudeProjectsRoot({}, { ...machine(), platform: "win32" })).toBeNull();
  });
});

describe("observeClaudeTranscript", () => {
  it("finds a transcript under the project directory derived from the cwd", async () => {
    await writeTranscript(CWD_SLUG, SESSION);
    const fs = countingFs();

    await expect(observeClaudeTranscript(SESSION, CWD, projectsRoot, { fs })).resolves.toBe(
      "present"
    );
    // The common case costs one lstat, never the scan.
    expect(fs.readdirCalls).toEqual([]);
  });

  it("finds a transcript in a project directory the slug guess doesn't match", async () => {
    await writeTranscript("C--work-app", SESSION);
    await expect(observeClaudeTranscript(SESSION, CWD, projectsRoot)).resolves.toBe("present");
  });

  it("matches a transcript whose name differs only in case", async () => {
    await writeTranscript(CWD_SLUG, SESSION.toUpperCase());
    await expect(observeClaudeTranscript(SESSION, undefined, projectsRoot)).resolves.toBe(
      "present"
    );
  });

  it("reports missing when the store holds other conversations but not this one", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    await expect(observeClaudeTranscript(SESSION, CWD, projectsRoot)).resolves.toBe("missing");
  });

  it("reports missing for a store Claude Code created but never wrote a conversation into", async () => {
    await expect(observeClaudeTranscript(SESSION, CWD, projectsRoot)).resolves.toBe("missing");
  });

  it("reports unknown when the config dir itself doesn't exist", async () => {
    const absent = path.join(configDir, "absent", "projects");
    await expect(observeClaudeTranscript(SESSION, CWD, absent)).resolves.toBe("unknown");
  });

  it("reports unknown without reading anything when there is no store or no real id", async () => {
    const fs = countingFs();
    await expect(observeClaudeTranscript(SESSION, CWD, null, { fs })).resolves.toBe("unknown");
    await expect(observeClaudeTranscript("s-1", CWD, projectsRoot, { fs })).resolves.toBe(
      "unknown"
    );
    expect(fs.readdirCalls).toEqual([]);
    expect(fs.lstatCalls).toEqual([]);
  });

  it("skips a stray file beside the project directories", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    await writeFile(path.join(projectsRoot, "notes.txt"), "not a project");
    await expect(observeClaudeTranscript(SESSION, CWD, projectsRoot)).resolves.toBe("missing");
  });

  it("reports unknown when a project directory can't be read, since the id could be in it", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    await mkdir(path.join(projectsRoot, "locked"));
    const fs: ClaudeStoreFs = {
      ...realFs,
      readdir: async (target) => {
        if (path.basename(target) === "locked") {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return realFs.readdir(target);
      },
    };
    await expect(observeClaudeTranscript(SESSION, CWD, projectsRoot, { fs })).resolves.toBe(
      "unknown"
    );
  });

  it("leaves a store that hung alone for a while instead of paying the budget again", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    const hanging: ClaudeStoreFs = { ...realFs, lstat: () => new Promise(() => {}) };
    await expect(
      observeClaudeTranscript(SESSION, CWD, projectsRoot, { fs: hanging, timeoutMs: 20 })
    ).resolves.toBe("unknown");

    const fs = countingFs();
    await expect(observeClaudeTranscript(SESSION, CWD, projectsRoot, { fs })).resolves.toBe(
      "unknown"
    );
    expect(fs.lstatCalls).toEqual([]);
    expect(fs.readdirCalls).toEqual([]);
  });

  it("reports unknown when the scan hangs past the budget", async () => {
    const fs: ClaudeStoreFs = { ...realFs, readdir: () => new Promise(() => {}) };
    await expect(
      observeClaudeTranscript(SESSION, undefined, projectsRoot, { fs, timeoutMs: 20 })
    ).resolves.toBe("unknown");
  });

  it("shares one scan between concurrent lookups", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    const fs = countingFs();

    const results = await Promise.all([
      observeClaudeTranscript(SESSION, undefined, projectsRoot, { fs }),
      observeClaudeTranscript(OTHER, undefined, projectsRoot, { fs }),
    ]);

    expect(results).toEqual(["missing", "present"]);
    expect(fs.readdirCalls.filter((target) => target === projectsRoot)).toHaveLength(1);
  });

  it("lets a caller joining a slow scan give up at its own deadline", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    let releaseRoot: () => void = () => {};
    const rootListed = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    const slow: ClaudeStoreFs = {
      ...realFs,
      readdir: async (target) => {
        if (target === projectsRoot) await rootListed;
        return realFs.readdir(target);
      },
    };

    const owner = observeClaudeTranscript(SESSION, undefined, projectsRoot, {
      fs: slow,
      timeoutMs: 30_000,
    });
    await expect(
      observeClaudeTranscript(SESSION, undefined, projectsRoot, { fs: slow, timeoutMs: 20 })
    ).resolves.toBe("unknown");
    releaseRoot();
    // The joiner running out of time says nothing about the store itself.
    await expect(owner).resolves.toBe("missing");
  });

  it("never remembers a missing, so the first message's transcript is seen at once", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    await expect(observeClaudeTranscript(SESSION, undefined, projectsRoot)).resolves.toBe(
      "missing"
    );

    await writeTranscript(CWD_SLUG, SESSION);
    await expect(observeClaudeTranscript(SESSION, undefined, projectsRoot)).resolves.toBe(
      "present"
    );
  });
});

describe("findUntouchedClaudeSession", () => {
  it("names the id to reassign when a resume has no conversation behind it", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    await expect(
      findUntouchedClaudeSession(`claude --resume ${SESSION}`, "claude", {
        cwd: CWD,
        agentSessionId: SESSION,
        projectsRoot,
      })
    ).resolves.toBe(SESSION);
  });

  it("keeps the resume when the conversation exists", async () => {
    await writeTranscript(CWD_SLUG, SESSION);
    await expect(
      findUntouchedClaudeSession(`claude --resume ${SESSION}`, "claude", {
        cwd: CWD,
        projectsRoot,
      })
    ).resolves.toBeUndefined();
  });

  it("keeps the resume without reading anything when the pane's store isn't certain", async () => {
    const fs = countingFs();
    await expect(
      findUntouchedClaudeSession(
        `claude --resume ${SESSION}`,
        "claude",
        { cwd: CWD, projectsRoot: null },
        { fs }
      )
    ).resolves.toBeUndefined();
    expect(fs.lstatCalls).toEqual([]);
    expect(fs.readdirCalls).toEqual([]);
  });

  it("leaves a pane alone when its record names a different id than its command resumes", async () => {
    await writeTranscript(CWD_SLUG, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    await expect(
      findUntouchedClaudeSession(`claude --resume ${SESSION}`, "claude", {
        cwd: CWD,
        agentSessionId: OTHER,
        projectsRoot,
      })
    ).resolves.toBeUndefined();
  });

  it("ignores launches that resume nothing and agents that aren't Claude", async () => {
    const fs = countingFs();
    await expect(
      findUntouchedClaudeSession(
        `claude --session-id ${SESSION}`,
        "claude",
        { cwd: CWD, projectsRoot },
        { fs }
      )
    ).resolves.toBeUndefined();
    await expect(
      findUntouchedClaudeSession(
        `codex resume ${SESSION}`,
        "codex",
        { cwd: CWD, projectsRoot },
        { fs }
      )
    ).resolves.toBeUndefined();
    expect(fs.readdirCalls).toEqual([]);
    expect(fs.lstatCalls).toEqual([]);
  });
});

const BOOKMARK = { bookmarkedAt: 1 } as AgentSessionRecord["bookmark"];

describe("isClaudeSessionWithoutTranscript", () => {
  beforeEach(async () => {
    await writeTranscript(CWD_SLUG, OTHER);
  });

  it("judges a closed session by the store its own terminal launched against", async () => {
    rememberClaudePaneStore("term-1", projectsRoot);

    await expect(
      isClaudeSessionWithoutTranscript(
        { agentId: "claude", sessionId: SESSION, cwd: CWD },
        "term-1"
      )
    ).resolves.toBe(true);
    await expect(
      isClaudeSessionWithoutTranscript({ agentId: "claude", sessionId: OTHER, cwd: CWD }, "term-1")
    ).resolves.toBe(false);
  });

  it("never judges a terminal whose store is unknown or was never remembered", async () => {
    rememberClaudePaneStore("term-uncertain", null);
    for (const terminalId of ["term-uncertain", "term-never-spawned"]) {
      await expect(
        isClaudeSessionWithoutTranscript(
          { agentId: "claude", sessionId: SESSION, cwd: CWD },
          terminalId
        )
      ).resolves.toBe(false);
    }
  });

  it("leaves bookmarks and other agents alone", async () => {
    rememberClaudePaneStore("term-1", projectsRoot);
    await expect(
      isClaudeSessionWithoutTranscript(
        { agentId: "claude", sessionId: SESSION, cwd: CWD, bookmark: BOOKMARK },
        "term-1"
      )
    ).resolves.toBe(false);
    await expect(
      isClaudeSessionWithoutTranscript({ agentId: "codex", sessionId: SESSION, cwd: CWD }, "term-1")
    ).resolves.toBe(false);
  });

  it("forgets the oldest terminals once it remembers too many", async () => {
    rememberClaudePaneStore("term-oldest", projectsRoot);
    for (let i = 0; i < 1_024; i++) rememberClaudePaneStore(`term-${i}`, projectsRoot);

    const record = { agentId: "claude", sessionId: SESSION, cwd: CWD };
    await expect(isClaudeSessionWithoutTranscript(record, "term-oldest")).resolves.toBe(false);
    await expect(isClaudeSessionWithoutTranscript(record, "term-1023")).resolves.toBe(true);
  });
});

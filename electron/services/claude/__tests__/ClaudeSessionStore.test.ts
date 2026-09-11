import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import type { AgentSessionRecord } from "../../../../shared/types/ipc/agentSessionHistory.js";
import {
  __resetClaudeSessionStoreForTests,
  dropClaudeSessionsWithoutTranscript,
  findUntouchedClaudeSession,
  isClaudeSessionWithoutTranscript,
  observeClaudeTranscript,
  resolvePaneClaudeProjectsRoot,
  type ClaudeStoreFs,
  type ClaudeStoreOptions,
} from "../ClaudeSessionStore.js";

const SESSION = "006fdfc0-67bf-4df0-ad82-48ebfe4df184";
const OTHER = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
const CWD = "/work/app";
const CWD_SLUG = "-work-app";

const realFs: ClaudeStoreFs = {
  lstat: (target) => lstat(target),
  readdir: (target) => readdir(target),
};

let configDir: string;
let projectsRoot: string;
/** A POSIX pane whose login profile points Claude at the temp store. */
let context: ClaudeStoreOptions;

beforeEach(async () => {
  __resetClaudeSessionStoreForTests();
  configDir = await mkdtemp(path.join(os.tmpdir(), "claude-session-store-"));
  projectsRoot = path.join(configDir, "projects");
  context = {
    platform: "linux",
    env: {},
    readShellEnv: () => ({ CLAUDE_CONFIG_DIR: configDir }),
  };
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

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
  const linux = (shell: Record<string, string> | undefined, env: Record<string, string> = {}) => ({
    platform: "linux" as const,
    env,
    readShellEnv: () => shell,
  });

  it("follows a store the login profile exports, which main never inherits", () => {
    expect(resolvePaneClaudeProjectsRoot(undefined, linux({ CLAUDE_CONFIG_DIR: configDir }))).toBe(
      projectsRoot
    );
  });

  it("uses the default store when neither the profile nor the pane relocates it", () => {
    expect(resolvePaneClaudeProjectsRoot(undefined, linux({}))).toBe(
      path.join(os.homedir(), ".claude", "projects")
    );
  });

  it("follows the pane's own override when the profile sets none", () => {
    expect(resolvePaneClaudeProjectsRoot({ CLAUDE_CONFIG_DIR: configDir }, linux({}))).toBe(
      projectsRoot
    );
  });

  it("agrees with a profile that exports the same store the pane inherits", () => {
    expect(
      resolvePaneClaudeProjectsRoot(
        undefined,
        linux({ CLAUDE_CONFIG_DIR: configDir }, { CLAUDE_CONFIG_DIR: configDir })
      )
    ).toBe(projectsRoot);
  });

  it("can't say which store a POSIX pane reads before its shell was observed", () => {
    expect(resolvePaneClaudeProjectsRoot(undefined, linux(undefined))).toBeNull();
  });

  it("refuses a profile and a pane that name different stores", () => {
    expect(
      resolvePaneClaudeProjectsRoot(
        { CLAUDE_CONFIG_DIR: configDir },
        linux({ CLAUDE_CONFIG_DIR: path.join(configDir, "elsewhere") })
      )
    ).toBeNull();
  });

  it("refuses a relative override, which the CLI resolves against each pane's own cwd", () => {
    expect(
      resolvePaneClaudeProjectsRoot(undefined, linux({ CLAUDE_CONFIG_DIR: "relative/claude" }))
    ).toBeNull();
  });

  it("trusts what a Windows pane inherits, since it sources no login profile", () => {
    expect(
      resolvePaneClaudeProjectsRoot(undefined, {
        platform: "win32",
        env: { CLAUDE_CONFIG_DIR: configDir },
        readShellEnv: () => undefined,
      })
    ).toBe(projectsRoot);
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
    const slow: ClaudeStoreFs = {
      ...realFs,
      readdir: async (target) => {
        if (target === projectsRoot) await new Promise((resolve) => setTimeout(resolve, 150));
        return realFs.readdir(target);
      },
    };

    const owner = observeClaudeTranscript(SESSION, undefined, projectsRoot, {
      fs: slow,
      timeoutMs: 1_000,
    });
    await expect(
      observeClaudeTranscript(SESSION, undefined, projectsRoot, { fs: slow, timeoutMs: 20 })
    ).resolves.toBe("unknown");
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
      findUntouchedClaudeSession(
        `claude --resume ${SESSION}`,
        "claude",
        { cwd: CWD, agentSessionId: SESSION },
        context
      )
    ).resolves.toBe(SESSION);
  });

  it("keeps the resume when the conversation exists", async () => {
    await writeTranscript(CWD_SLUG, SESSION);
    await expect(
      findUntouchedClaudeSession(`claude --resume ${SESSION}`, "claude", { cwd: CWD }, context)
    ).resolves.toBeUndefined();
  });

  it("keeps the resume when it can't tell which store the pane reads", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    await expect(
      findUntouchedClaudeSession(
        `claude --resume ${SESSION}`,
        "claude",
        { cwd: CWD },
        { ...context, readShellEnv: () => undefined }
      )
    ).resolves.toBeUndefined();
  });

  it("checks the store the pane's own environment points at", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    await expect(
      findUntouchedClaudeSession(
        `claude --resume ${SESSION}`,
        "claude",
        { cwd: CWD, env: { CLAUDE_CONFIG_DIR: configDir } },
        { ...context, readShellEnv: () => ({}) }
      )
    ).resolves.toBe(SESSION);
  });

  it("leaves a pane alone when its record names a different id than its command resumes", async () => {
    await writeTranscript(CWD_SLUG, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    await expect(
      findUntouchedClaudeSession(
        `claude --resume ${SESSION}`,
        "claude",
        { cwd: CWD, agentSessionId: OTHER },
        context
      )
    ).resolves.toBeUndefined();
  });

  it("ignores launches that resume nothing and agents that aren't Claude", async () => {
    const fs = countingFs();
    await expect(
      findUntouchedClaudeSession(
        `claude --session-id ${SESSION}`,
        "claude",
        { cwd: CWD },
        {
          ...context,
          fs,
        }
      )
    ).resolves.toBeUndefined();
    await expect(
      findUntouchedClaudeSession(
        `codex resume ${SESSION}`,
        "codex",
        { cwd: CWD },
        { ...context, fs }
      )
    ).resolves.toBeUndefined();
    expect(fs.readdirCalls).toEqual([]);
    expect(fs.lstatCalls).toEqual([]);
  });
});

type HistoryRecord = Pick<AgentSessionRecord, "agentId" | "sessionId" | "bookmark" | "title">;
const BOOKMARK = { bookmarkedAt: 1 } as AgentSessionRecord["bookmark"];

describe("isClaudeSessionWithoutTranscript", () => {
  beforeEach(async () => {
    await writeTranscript(CWD_SLUG, OTHER);
  });

  it("flags a session still wearing Claude's pre-conversation title", async () => {
    for (const title of ["✳ Claude Code", "Claude", null]) {
      await expect(
        isClaudeSessionWithoutTranscript(
          { agentId: "claude", sessionId: SESSION, cwd: CWD, title },
          context
        )
      ).resolves.toBe(true);
    }
  });

  it("keeps anything that shows a conversation happened or isn't this agent's to judge", async () => {
    const records = [
      // Retitled after its conversation, so its store may be one this process can't see.
      { agentId: "claude", sessionId: SESSION, cwd: CWD, title: "✳ Fix the login redirect" },
      { agentId: "claude", sessionId: OTHER, cwd: CWD, title: "✳ Claude Code" },
      { agentId: "claude", sessionId: SESSION, cwd: CWD, title: null, bookmark: BOOKMARK },
      { agentId: "codex", sessionId: SESSION, cwd: CWD, title: null },
    ];
    for (const record of records) {
      await expect(isClaudeSessionWithoutTranscript(record, context)).resolves.toBe(false);
    }
  });
});

describe("dropClaudeSessionsWithoutTranscript", () => {
  it("hides untouched Claude sessions with no conversation and keeps everything else", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    const records: HistoryRecord[] = [
      { agentId: "claude", sessionId: SESSION, title: "✳ Claude Code" },
      { agentId: "claude", sessionId: OTHER, title: "✳ Claude Code" },
      { agentId: "claude", sessionId: SESSION, title: "✳ Fix the login redirect" },
      { agentId: "codex", sessionId: SESSION, title: null },
      { agentId: "claude", sessionId: SESSION, title: null, bookmark: BOOKMARK },
    ];

    await expect(dropClaudeSessionsWithoutTranscript(records, context)).resolves.toEqual(
      records.slice(1)
    );
  });

  it("filters nothing when it can't tell which store the sessions came from", async () => {
    const records: HistoryRecord[] = [{ agentId: "claude", sessionId: SESSION, title: null }];
    await expect(
      dropClaudeSessionsWithoutTranscript(records, { ...context, readShellEnv: () => undefined })
    ).resolves.toBe(records);
  });

  it("doesn't read the store for a list with nothing to check", async () => {
    const fs = countingFs();
    const records: HistoryRecord[] = [
      { agentId: "codex", sessionId: SESSION, title: null },
      { agentId: "claude", sessionId: OTHER, title: null, bookmark: BOOKMARK },
      { agentId: "claude", sessionId: OTHER, title: "✳ Fix the login redirect" },
    ];
    await expect(dropClaudeSessionsWithoutTranscript(records, { ...context, fs })).resolves.toBe(
      records
    );
    expect(fs.readdirCalls).toEqual([]);
  });
});

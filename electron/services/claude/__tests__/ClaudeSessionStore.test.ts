import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import type { AgentSessionRecord } from "../../../../shared/types/ipc/agentSessionHistory.js";
import {
  dropClaudeSessionsWithoutTranscript,
  findUntouchedClaudeSession,
  isClaudeSessionWithoutTranscript,
  observeClaudeTranscript,
  resolveClaudeProjectsRoot,
  type ClaudeStoreFs,
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
let env: Record<string, string>;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(os.tmpdir(), "claude-session-store-"));
  env = { CLAUDE_CONFIG_DIR: configDir };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(configDir, { recursive: true, force: true });
});

async function writeTranscript(slug: string, sessionId: string): Promise<void> {
  const dir = path.join(configDir, "projects", slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
}

function countingFs(): ClaudeStoreFs & { readdirCalls: string[]; lstatCalls: string[] } {
  const readdirCalls: string[] = [];
  const lstatCalls: string[] = [];
  return {
    readdirCalls,
    lstatCalls,
    lstat: (target) => {
      lstatCalls.push(target);
      return realFs.lstat(target);
    },
    readdir: (target) => {
      readdirCalls.push(target);
      return realFs.readdir(target);
    },
  };
}

describe("resolveClaudeProjectsRoot", () => {
  it("follows CLAUDE_CONFIG_DIR to the relocated store", () => {
    expect(resolveClaudeProjectsRoot({ CLAUDE_CONFIG_DIR: configDir })).toBe(
      path.join(configDir, "projects")
    );
  });

  it("falls back to the default store under the home directory", () => {
    expect(resolveClaudeProjectsRoot({})).toBe(path.join(os.homedir(), ".claude", "projects"));
  });

  it("refuses a relative override, which the CLI resolves against each pane's own cwd", () => {
    expect(resolveClaudeProjectsRoot({ CLAUDE_CONFIG_DIR: "relative/claude" })).toBeNull();
  });
});

describe("observeClaudeTranscript", () => {
  it("finds a transcript under the project directory derived from the cwd", async () => {
    await writeTranscript(CWD_SLUG, SESSION);
    const fs = countingFs();

    await expect(observeClaudeTranscript(SESSION, CWD, { env, fs })).resolves.toBe("present");
    // The common case costs one lstat, never the scan.
    expect(fs.readdirCalls).toEqual([]);
  });

  it("finds a transcript in a project directory the slug guess doesn't match", async () => {
    await writeTranscript("C--work-app", SESSION);
    await expect(observeClaudeTranscript(SESSION, CWD, { env })).resolves.toBe("present");
  });

  it("reports missing when the store holds other conversations but not this one", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    await expect(observeClaudeTranscript(SESSION, CWD, { env })).resolves.toBe("missing");
  });

  it("reports missing for a store Claude Code created but never wrote a conversation into", async () => {
    await expect(observeClaudeTranscript(SESSION, CWD, { env })).resolves.toBe("missing");
  });

  it("reports unknown when the config dir itself doesn't exist", async () => {
    const absent = { CLAUDE_CONFIG_DIR: path.join(configDir, "absent") };
    await expect(observeClaudeTranscript(SESSION, CWD, { env: absent })).resolves.toBe("unknown");
  });

  it("reports unknown for an id that can't name a Claude session, without reading anything", async () => {
    const fs = countingFs();
    await expect(observeClaudeTranscript("s-1", CWD, { env, fs })).resolves.toBe("unknown");
    expect(fs.readdirCalls).toEqual([]);
    expect(fs.lstatCalls).toEqual([]);
  });

  it("skips a stray file beside the project directories", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    await writeFile(path.join(configDir, "projects", "notes.txt"), "not a project");
    await expect(observeClaudeTranscript(SESSION, CWD, { env })).resolves.toBe("missing");
  });

  it("reports unknown when a project directory can't be read, since the id could be in it", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    await mkdir(path.join(configDir, "projects", "locked"));
    const fs: ClaudeStoreFs = {
      ...realFs,
      readdir: async (target) => {
        if (path.basename(target) === "locked") {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return realFs.readdir(target);
      },
    };
    await expect(observeClaudeTranscript(SESSION, CWD, { env, fs })).resolves.toBe("unknown");
  });

  it("reports unknown when the fast path hangs past the budget", async () => {
    const fs: ClaudeStoreFs = { ...realFs, lstat: () => new Promise(() => {}) };
    await expect(observeClaudeTranscript(SESSION, CWD, { env, fs, timeoutMs: 20 })).resolves.toBe(
      "unknown"
    );
  });

  it("reports unknown when the scan hangs past the budget", async () => {
    const fs: ClaudeStoreFs = { ...realFs, readdir: () => new Promise(() => {}) };
    await expect(
      observeClaudeTranscript(SESSION, undefined, { env, fs, timeoutMs: 20 })
    ).resolves.toBe("unknown");
  });

  it("shares one scan between concurrent lookups", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    const fs = countingFs();

    const results = await Promise.all([
      observeClaudeTranscript(SESSION, undefined, { env, fs }),
      observeClaudeTranscript(OTHER, undefined, { env, fs }),
    ]);

    expect(results).toEqual(["missing", "present"]);
    const projectsRoot = path.join(configDir, "projects");
    expect(fs.readdirCalls.filter((target) => target === projectsRoot)).toHaveLength(1);
  });

  it("never remembers a missing, so the first message's transcript is seen at once", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    await expect(observeClaudeTranscript(SESSION, undefined, { env })).resolves.toBe("missing");

    await writeTranscript(CWD_SLUG, SESSION);
    await expect(observeClaudeTranscript(SESSION, undefined, { env })).resolves.toBe("present");
  });
});

describe("findUntouchedClaudeSession", () => {
  it("names the id to reassign when a resume has no conversation behind it", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    await expect(
      findUntouchedClaudeSession(`claude --resume ${SESSION}`, "claude", {
        cwd: CWD,
        agentSessionId: SESSION,
        env,
      })
    ).resolves.toBe(SESSION);
  });

  it("keeps the resume when the conversation exists", async () => {
    await writeTranscript(CWD_SLUG, SESSION);
    await expect(
      findUntouchedClaudeSession(`claude --resume ${SESSION}`, "claude", { cwd: CWD, env })
    ).resolves.toBeUndefined();
  });

  it("keeps the resume when the store can't be read", async () => {
    const absent = { CLAUDE_CONFIG_DIR: path.join(configDir, "absent") };
    await expect(
      findUntouchedClaudeSession(`claude --resume ${SESSION}`, "claude", {
        cwd: CWD,
        env: absent,
      })
    ).resolves.toBeUndefined();
  });

  it("leaves a pane alone when its record names a different id than its command resumes", async () => {
    await writeTranscript(CWD_SLUG, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    await expect(
      findUntouchedClaudeSession(`claude --resume ${SESSION}`, "claude", {
        cwd: CWD,
        agentSessionId: OTHER,
        env,
      })
    ).resolves.toBeUndefined();
  });

  it("ignores launches that resume nothing and agents that aren't Claude", async () => {
    const fs = countingFs();
    await expect(
      findUntouchedClaudeSession(
        `claude --session-id ${SESSION}`,
        "claude",
        { cwd: CWD, env },
        { fs }
      )
    ).resolves.toBeUndefined();
    await expect(
      findUntouchedClaudeSession(`codex resume ${SESSION}`, "codex", { cwd: CWD, env }, { fs })
    ).resolves.toBeUndefined();
    expect(fs.readdirCalls).toEqual([]);
    expect(fs.lstatCalls).toEqual([]);
  });

  it("reads the store from Daintree's environment when the spawn doesn't relocate it", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    await expect(
      findUntouchedClaudeSession(`claude --resume ${SESSION}`, "claude", {
        cwd: CWD,
        env: { SOME_PRESET_VAR: "1" },
      })
    ).resolves.toBe(SESSION);
  });
});

type HistoryRecord = Pick<AgentSessionRecord, "agentId" | "sessionId" | "bookmark">;
const BOOKMARK = { bookmarkedAt: 1 } as AgentSessionRecord["bookmark"];

describe("isClaudeSessionWithoutTranscript", () => {
  it("flags only an unbookmarked Claude session with no transcript", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    const options = { env };

    await expect(
      isClaudeSessionWithoutTranscript({ agentId: "claude", sessionId: SESSION, cwd: CWD }, options)
    ).resolves.toBe(true);
    await expect(
      isClaudeSessionWithoutTranscript({ agentId: "claude", sessionId: OTHER, cwd: CWD }, options)
    ).resolves.toBe(false);
    await expect(
      isClaudeSessionWithoutTranscript(
        { agentId: "claude", sessionId: SESSION, cwd: CWD, bookmark: BOOKMARK },
        options
      )
    ).resolves.toBe(false);
    await expect(
      isClaudeSessionWithoutTranscript({ agentId: "codex", sessionId: SESSION, cwd: CWD }, options)
    ).resolves.toBe(false);
  });
});

describe("dropClaudeSessionsWithoutTranscript", () => {
  it("hides Claude sessions with no conversation and keeps everything else", async () => {
    await writeTranscript(CWD_SLUG, OTHER);
    const records: HistoryRecord[] = [
      { agentId: "claude", sessionId: SESSION },
      { agentId: "claude", sessionId: OTHER },
      { agentId: "codex", sessionId: SESSION },
      { agentId: "claude", sessionId: SESSION, bookmark: BOOKMARK },
    ];

    await expect(dropClaudeSessionsWithoutTranscript(records, { env })).resolves.toEqual([
      records[1],
      records[2],
      records[3],
    ]);
  });

  it("filters nothing when the store can't be read", async () => {
    const records: HistoryRecord[] = [{ agentId: "claude", sessionId: SESSION }];
    const absent = { CLAUDE_CONFIG_DIR: path.join(configDir, "absent") };
    await expect(dropClaudeSessionsWithoutTranscript(records, { env: absent })).resolves.toBe(
      records
    );
  });

  it("doesn't read the store for a list with no Claude sessions to check", async () => {
    const fs = countingFs();
    const records: HistoryRecord[] = [
      { agentId: "codex", sessionId: SESSION },
      { agentId: "claude", sessionId: OTHER, bookmark: BOOKMARK },
    ];
    await expect(dropClaudeSessionsWithoutTranscript(records, { env, fs })).resolves.toBe(records);
    expect(fs.readdirCalls).toEqual([]);
  });
});

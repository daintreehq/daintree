import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifySessionMeta,
  collectTreePids,
  parseLsofFields,
  probeCodexSessionFile,
  rolloutSessionId,
  type ListingRunner,
} from "../CodexSessionFileProbe.js";

const ROOT_ID = "01a19a09-d462-7101-a841-24b57d849008";
const CHILD_ID = "02b29b19-e573-7212-b952-35c68e95a119";
const OTHER_ROOT_ID = "03c39c29-f684-7323-ca63-46d79fa6b22a";

function sessionMeta(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: "2026-11-02T04:14:57.000Z",
    type: "session_meta",
    payload: { id, session_id: id, source: "cli", cwd: "/work", ...extra },
  });
}

/** A shell (100) running the npm launcher (101), whose child is the native binary (102). */
const PS_TREE = ["  1     0", "100     1", "101   100", "102   101", "103   102", "900     1"].join(
  "\n"
);

let codexHome: string;

beforeEach(async () => {
  codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-home-"));
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
});

async function writeRollout(id: string, firstLine: string, rest = ""): Promise<string> {
  const dir = path.join(codexHome, "sessions", "2026", "11", "02");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-02T04-14-57-${id}.jsonl`);
  await writeFile(file, `${firstLine}\n${rest}`);
  return file;
}

interface OpenFile {
  pid: number;
  fd: string;
  access: string;
  type?: string;
  inode?: string;
  name: string;
}

async function lsofFor(files: OpenFile[]): Promise<string> {
  const lines: string[] = [];
  const byPid = new Map<number, OpenFile[]>();
  for (const file of files) byPid.set(file.pid, [...(byPid.get(file.pid) ?? []), file]);
  for (const [pid, held] of byPid) {
    lines.push(`p${pid}`);
    for (const file of held) {
      const inode = file.inode ?? String((await stat(file.name)).ino);
      lines.push(`f${file.fd}`, `a${file.access}`, `t${file.type ?? "REG"}`, `i${inode}`);
      lines.push(`n${file.name}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function runner(lsofStdout: string, overrides: Partial<Record<"ps" | "lsof", unknown>> = {}) {
  return vi.fn<ListingRunner>(async (file) => {
    const override = overrides[file as "ps" | "lsof"];
    if (override instanceof Error) throw override;
    if (override !== undefined) return override as { stdout: string; exitCode: number };
    if (file === "ps") return { stdout: PS_TREE, exitCode: 0 };
    if (file === "lsof") return { stdout: lsofStdout, exitCode: 0 };
    throw new Error(`unexpected ${file}`);
  });
}

describe("collectTreePids", () => {
  it("walks from the pane's root through every descendant and nothing else", () => {
    expect(collectTreePids(PS_TREE, 100)?.sort((a, b) => a - b)).toEqual([100, 101, 102, 103]);
  });

  it("refuses a tree too big to list whole", () => {
    const lines = ["100 1", ...Array.from({ length: 300 }, (_, i) => `${1000 + i} 100`)];
    expect(collectTreePids(lines.join("\n"), 100)).toBeNull();
  });
});

describe("parseLsofFields", () => {
  it("attributes each file to the process listed above it", () => {
    const records = parseLsofFields(
      ["p10", "f3", "aw", "tREG", "i7", "n/a", "p11", "fcwd", "ar", "tDIR", "n/b", ""].join("\n")
    );
    expect(records.map((r) => [r.pid, r.fd, r.access, r.type, r.inode, r.name])).toEqual([
      [10, "3", "w", "REG", "7", "/a"],
      [11, "cwd", "r", "DIR", "", "/b"],
    ]);
  });
});

describe("rolloutSessionId", () => {
  it("reads the id from a rollout in a dated sessions folder, under any home", () => {
    expect(
      rolloutSessionId(
        `/elsewhere/profile-b/sessions/2026/11/02/rollout-2026-11-02T04-14-57-${ROOT_ID}.jsonl`
      )
    ).toBe(ROOT_ID);
  });

  it("refuses a rollout name outside the dated layout", () => {
    expect(
      rolloutSessionId(`/home/me/.codex/archived/rollout-2026-11-02T04-14-57-${ROOT_ID}.jsonl`)
    ).toBeNull();
    expect(
      rolloutSessionId(`sessions/2026/11/02/rollout-2026-11-02T04-14-57-${ROOT_ID}.jsonl`)
    ).toBeNull();
  });
});

describe("classifySessionMeta", () => {
  it("tells a root session from a subagent thread", () => {
    expect(classifySessionMeta(sessionMeta(ROOT_ID), ROOT_ID)).toBe("root");
    expect(classifySessionMeta(sessionMeta(CHILD_ID, { session_id: ROOT_ID }), CHILD_ID)).toBe(
      "child"
    );
    expect(
      classifySessionMeta(
        sessionMeta(CHILD_ID, { session_id: undefined, source: { subagent: {} } }),
        CHILD_ID
      )
    ).toBe("child");
  });

  it("refuses a record that isn't this file's session_meta", () => {
    expect(classifySessionMeta(sessionMeta(OTHER_ROOT_ID), ROOT_ID)).toBe("invalid");
    expect(classifySessionMeta(JSON.stringify({ type: "response_item" }), ROOT_ID)).toBe("invalid");
    expect(classifySessionMeta("{not json", ROOT_ID)).toBe("invalid");
  });
});

describe("probeCodexSessionFile", () => {
  it("answers the root rollout the native child holds open for writing, wherever its home is", async () => {
    const file = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID), '{"type":"event_msg"}\n');
    const run = runner(await lsofFor([{ pid: 102, fd: "37", access: "u", name: file }]));

    await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
      status: "observed",
      agentId: "codex",
      sessionId: ROOT_ID,
      path: file,
      observedBy: "open-for-writing",
    });
    const lsofArgs = run.mock.calls.find(([file]) => file === "lsof")?.[1] ?? [];
    expect(lsofArgs[lsofArgs.indexOf("-p") + 1]?.split(",").sort()).toEqual([
      "100",
      "101",
      "102",
      "103",
    ]);
  });

  it("picks the root out of a session whose subagents hold rollouts too", async () => {
    const root = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID));
    const child = await writeRollout(CHILD_ID, sessionMeta(CHILD_ID, { session_id: ROOT_ID }));
    const run = runner(
      await lsofFor([
        { pid: 102, fd: "37", access: "u", name: root },
        { pid: 102, fd: "41", access: "w", name: child },
      ])
    );

    const result = await probeCodexSessionFile(100, { platform: "linux", run });
    expect(result).toMatchObject({ status: "observed", sessionId: ROOT_ID, path: root });
  });

  it("names none when two root sessions are open", async () => {
    const a = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID));
    const b = await writeRollout(OTHER_ROOT_ID, sessionMeta(OTHER_ROOT_ID));
    const run = runner(
      await lsofFor([
        { pid: 102, fd: "37", access: "u", name: a },
        { pid: 103, fd: "12", access: "w", name: b },
      ])
    );

    await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
      status: "unknown",
      reason: "ambiguous",
    });
  });

  it("counts one file held twice as one", async () => {
    const file = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID));
    const run = runner(
      await lsofFor([
        { pid: 101, fd: "20", access: "w", name: file },
        { pid: 102, fd: "37", access: "u", name: file },
      ])
    );

    const result = await probeCodexSessionFile(100, { platform: "darwin", run });
    expect(result).toMatchObject({ status: "observed", sessionId: ROOT_ID });
  });

  it("ignores rollouts open only for reading", async () => {
    const file = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID));
    const run = runner(await lsofFor([{ pid: 102, fd: "37", access: "r", name: file }]));

    await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
      status: "unknown",
      reason: "not-observed",
    });
  });

  it("refuses a path that no longer names the file lsof saw", async () => {
    const file = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID));
    const inode = String((await stat(file)).ino + 1);
    const run = runner(await lsofFor([{ pid: 102, fd: "37", access: "u", inode, name: file }]));

    await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
      status: "unknown",
      reason: "unverified",
    });
  });

  it("refuses a symlink planted where the rollout was", async () => {
    const real = path.join(codexHome, "elsewhere.jsonl");
    await writeFile(real, `${sessionMeta(ROOT_ID)}\n`);
    const dir = path.join(codexHome, "sessions", "2026", "11", "02");
    await mkdir(dir, { recursive: true });
    const link = path.join(dir, `rollout-2026-11-02T04-14-57-${ROOT_ID}.jsonl`);
    await symlink(real, link);
    const inode = String((await stat(real)).ino);
    const run = runner(await lsofFor([{ pid: 102, fd: "37", access: "u", inode, name: link }]));

    await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
      status: "unknown",
      reason: "unverified",
    });
  });

  it("refuses a subagent's rollout with no root beside it", async () => {
    const child = await writeRollout(CHILD_ID, sessionMeta(CHILD_ID, { session_id: ROOT_ID }));
    const run = runner(await lsofFor([{ pid: 102, fd: "41", access: "w", name: child }]));

    await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
      status: "unknown",
      reason: "unverified",
    });
  });

  it("refuses a rollout whose first record has not ended yet", async () => {
    const dir = path.join(codexHome, "sessions", "2026", "11", "02");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-11-02T04-14-57-${ROOT_ID}.jsonl`);
    await writeFile(file, sessionMeta(ROOT_ID));
    const run = runner(await lsofFor([{ pid: 102, fd: "37", access: "u", name: file }]));

    await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
      status: "unknown",
      reason: "unverified",
    });
  });

  it("still reads the listing when lsof exits 1 for a process that went away", async () => {
    const file = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID));
    const run = runner("", {
      lsof: {
        stdout: await lsofFor([{ pid: 102, fd: "37", access: "u", name: file }]),
        exitCode: 1,
      },
    });

    const result = await probeCodexSessionFile(100, { platform: "darwin", run });
    expect(result).toMatchObject({ status: "observed", sessionId: ROOT_ID });
  });

  it("answers probe-failed when a listing can't run or fails", async () => {
    const missing = Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
    await expect(
      probeCodexSessionFile(100, { platform: "linux", run: runner("", { lsof: missing }) })
    ).resolves.toEqual({ status: "unknown", reason: "probe-failed" });
    await expect(
      probeCodexSessionFile(100, {
        platform: "darwin",
        run: runner("", { ps: { stdout: "", exitCode: 1 } }),
      })
    ).resolves.toEqual({ status: "unknown", reason: "probe-failed" });
    await expect(
      probeCodexSessionFile(100, {
        platform: "darwin",
        run: runner("", { lsof: { stdout: "", exitCode: 2 } }),
      })
    ).resolves.toEqual({ status: "unknown", reason: "probe-failed" });
  });

  it("runs nothing on Windows", async () => {
    const run = runner("");
    await expect(probeCodexSessionFile(100, { platform: "win32", run })).resolves.toEqual({
      status: "unknown",
      reason: "unsupported-platform",
    });
    expect(run).not.toHaveBeenCalled();
  });
});

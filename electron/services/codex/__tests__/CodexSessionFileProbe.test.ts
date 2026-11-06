import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifySessionMeta,
  findPaneCodexProcess,
  isCodexExecutable,
  parseCensus,
  parseLsofFields,
  probeCodexSessionFile,
  rolloutThreadId,
  runListing,
  type ListingResult,
  type ListingRunner,
} from "../CodexSessionFileProbe.js";

const ROOT_ID = "01a19a09-d462-7101-a841-24b57d849008";
const CHILD_ID = "02b29b19-e573-7212-b952-35c68e95a119";
const OTHER_ROOT_ID = "03c39c29-f684-7323-ca63-46d79fa6b22a";
const REVERT_ID = "04d49d39-0795-7434-db74-57e8a0b7c33b";

const NATIVE = "/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex";
const STARTED = "Mon Nov  2 04:36:27 2026";

function sessionMeta(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: "2026-11-02T04:14:57.000Z",
    type: "session_meta",
    payload: { id, session_id: id, source: "cli", cwd: "/work", ...extra },
  });
}

function censusLine(pid: number, ppid: number, comm: string, started = STARTED): string {
  return `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${started}     ${comm}`;
}

/**
 * A shell (100) running the npm launcher (101), whose child is the native
 * binary (102). Codex ran a tool (103) that started another `codex` (104).
 * 900 is another pane's Codex.
 */
const PS_TREE = [
  censusLine(1, 0, "/sbin/launchd"),
  censusLine(100, 1, "-zsh"),
  censusLine(101, 100, "node"),
  censusLine(102, 101, NATIVE),
  censusLine(103, 102, "/bin/zsh"),
  censusLine(104, 103, "codex"),
  censusLine(900, 1, NATIVE),
].join("\n");

let codexHome: string;

beforeEach(async () => {
  codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-home-"));
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
});

function rolloutPath(id: string, revertedTo?: string): string {
  const dir = path.join(codexHome, "sessions", "2026", "11", "02");
  const ids = revertedTo ? `${id}_${revertedTo}` : id;
  return path.join(dir, `rollout-2026-11-02T04-14-57-${ids}.jsonl`);
}

async function writeRollout(
  id: string,
  firstLine: string,
  options: { rest?: string; revertedTo?: string } = {}
): Promise<string> {
  const file = rolloutPath(id, options.revertedTo);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${firstLine}\n${options.rest ?? ""}`);
  return file;
}

interface OpenFile {
  pid?: number;
  fd: string;
  access: string;
  type?: string;
  device?: string;
  inode?: string;
  name: string;
}

async function lsofFor(files: OpenFile[]): Promise<string> {
  const lines: string[] = [];
  const byPid = new Map<number, OpenFile[]>();
  for (const file of files) {
    const pid = file.pid ?? 102;
    byPid.set(pid, [...(byPid.get(pid) ?? []), file]);
  }
  for (const [pid, held] of byPid) {
    lines.push(`p${pid}`);
    for (const file of held) {
      const stats = await stat(file.name).catch(() => null);
      const device = file.device ?? `0x${(stats?.dev ?? 0).toString(16)}`;
      const inode = file.inode ?? String(stats?.ino ?? 0);
      lines.push(`f${file.fd}`, `a${file.access}`, `t${file.type ?? "REG"}`, `D${device}`);
      lines.push(`i${inode}`, `n${file.name}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

type Overrides = Partial<Record<"census" | "lsof" | "recheck", ListingResult | Error>>;

/** Answers the census, the file listing and the one-process recheck the probe runs, in that order. */
function runner(lsofStdout: string, overrides: Overrides = {}) {
  return vi.fn<ListingRunner>(async (file, args) => {
    const step = file === "lsof" ? "lsof" : args.includes("-A") ? "census" : "recheck";
    const override = overrides[step];
    if (override instanceof Error) throw override;
    if (override) return override;
    if (step === "lsof") return { stdout: lsofStdout, exitCode: 0 };
    if (step === "census") return { stdout: PS_TREE, exitCode: 0 };
    const pid = Number(args[args.indexOf("-p") + 1]);
    const line = PS_TREE.split("\n").find((entry) => parseCensus(entry).has(pid));
    return line ? { stdout: line, exitCode: 0 } : { stdout: "", exitCode: 1 };
  });
}

describe("findPaneCodexProcess", () => {
  it("takes the outermost native Codex under the pane, past the npm launcher", () => {
    const found = findPaneCodexProcess(parseCensus(PS_TREE), 100);
    expect(found).toMatchObject({ status: "found", process: { pid: 102, ppid: 101 } });
  });

  it("finds none in a pane whose tree runs no Codex", () => {
    const shellOnly = [censusLine(100, 1, "-zsh"), censusLine(101, 100, "node")].join("\n");
    expect(findPaneCodexProcess(parseCensus(shellOnly), 100)).toEqual({ status: "none" });
  });

  it("names none when two Codex processes run side by side", () => {
    const twin = [censusLine(100, 1, "-zsh"), censusLine(101, 100, "codex")];
    twin.push(censusLine(102, 100, "codex-aarch64-apple-darwin"));
    expect(findPaneCodexProcess(parseCensus(twin.join("\n")), 100)).toEqual({
      status: "ambiguous",
    });
  });

  it("looks past a wrapper named like Codex to the real binary under it", () => {
    const wrapped = [
      censusLine(100, 1, "-bash"),
      censusLine(101, 100, "codex-wrapper"),
      censusLine(102, 101, "node"),
      censusLine(103, 102, "codex"),
    ].join("\n");
    expect(findPaneCodexProcess(parseCensus(wrapped), 100)).toMatchObject({
      status: "found",
      process: { pid: 103 },
    });
  });

  it("refuses a tree too big to search whole", () => {
    const lines = [censusLine(100, 1, "-zsh")];
    for (let i = 0; i < 300; i += 1) lines.push(censusLine(1000 + i, 100, "sleep"));
    expect(findPaneCodexProcess(parseCensus(lines.join("\n")), 100)).toEqual({
      status: "too-big",
    });
  });
});

describe("isCodexExecutable", () => {
  it("takes the native binary and a legacy package's per-target names, truncated or not", () => {
    expect(isCodexExecutable(NATIVE)).toBe(true);
    expect(isCodexExecutable("codex-aarch64-apple-darwin")).toBe(true);
    // Linux keeps 15 bytes of `codex-x86_64-unknown-linux-musl`.
    expect(isCodexExecutable("codex-x86_64-un")).toBe(true);
  });

  it("takes nothing else that starts with codex", () => {
    expect(isCodexExecutable("codex-wrapper")).toBe(false);
    expect(isCodexExecutable("codex-x86_64")).toBe(false);
    expect(isCodexExecutable("node")).toBe(false);
  });
});

describe("parseLsofFields", () => {
  it("attributes each file to the process listed above it", () => {
    const records = parseLsofFields(
      [
        "p10",
        "f3",
        "aw",
        "tREG",
        "D0x10",
        "i7",
        "n/a",
        "p11",
        "fcwd",
        "ar",
        "tDIR",
        "n/b",
        "",
      ].join("\n")
    );
    expect(records.map((r) => [r.pid, r.fd, r.access, r.type, r.device, r.inode, r.name])).toEqual([
      [10, "3", "w", "REG", "0x10", "7", "/a"],
      [11, "cwd", "r", "DIR", "", "", "/b"],
    ]);
  });
});

describe("rolloutThreadId", () => {
  it("reads the thread id from a rollout in a dated sessions folder, under any home", () => {
    expect(
      rolloutThreadId(
        `/elsewhere/profile-b/sessions/2026/11/02/rollout-2026-11-02T04-14-57-${ROOT_ID}.jsonl`
      )
    ).toBe(ROOT_ID);
  });

  it("reads it from a reverted thread's name, which keeps the thread id first", () => {
    expect(
      rolloutThreadId(
        `/h/sessions/2026/11/02/rollout-2026-11-02T04-14-57-${ROOT_ID}_${REVERT_ID}.jsonl`
      )
    ).toBe(ROOT_ID);
  });

  it("refuses a rollout name outside the dated layout", () => {
    expect(
      rolloutThreadId(`/home/me/.codex/archived/rollout-2026-11-02T04-14-57-${ROOT_ID}.jsonl`)
    ).toBeNull();
    expect(
      rolloutThreadId(`sessions/2026/11/02/rollout-2026-11-02T04-14-57-${ROOT_ID}.jsonl`)
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
      classifySessionMeta(sessionMeta(CHILD_ID, { parent_thread_id: ROOT_ID }), CHILD_ID)
    ).toBe("child");
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
  it.each(["u", "w"])(
    "answers the root rollout the pane's Codex holds open (access %s), wherever its home is",
    async (access) => {
      const file = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID), {
        rest: '{"type":"event_msg"}\n',
      });
      const run = runner(await lsofFor([{ fd: "37", access, name: file }]));

      await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
        status: "observed",
        agentId: "codex",
        sessionId: ROOT_ID,
        path: file,
        observedBy: "open-for-writing",
      });
      const lsofArgs = run.mock.calls.find(([command]) => command === "lsof")?.[1] ?? [];
      // Only the pane's own Codex is listed, in the fields the parser reads.
      expect(lsofArgs.slice(lsofArgs.indexOf("-p"), lsofArgs.indexOf("-p") + 2)).toEqual([
        "-p",
        "102",
      ]);
      expect(lsofArgs.slice(lsofArgs.indexOf("-F"), lsofArgs.indexOf("-F") + 2)).toEqual([
        "-F",
        "pfatDin",
      ]);
    }
  );

  it("answers a reverted thread's rollout by its thread id", async () => {
    const file = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID), { revertedTo: REVERT_ID });
    const run = runner(await lsofFor([{ fd: "37", access: "u", name: file }]));

    const result = await probeCodexSessionFile(100, { platform: "darwin", run });
    expect(result).toMatchObject({ status: "observed", sessionId: ROOT_ID, path: file });
  });

  it("picks the root out of a session whose subagents hold rollouts too", async () => {
    const root = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID));
    const child = await writeRollout(CHILD_ID, sessionMeta(CHILD_ID, { session_id: ROOT_ID }));
    const run = runner(
      await lsofFor([
        { fd: "37", access: "u", name: root },
        { fd: "41", access: "w", name: child },
      ])
    );

    const result = await probeCodexSessionFile(100, { platform: "linux", run });
    expect(result).toMatchObject({ status: "observed", sessionId: ROOT_ID, path: root });
  });

  it("never credits the pane with a conversation a nested codex is writing", async () => {
    // The pane's own Codex keeps no rollout (an ephemeral run); the one its
    // tool started does, and it isn't the pane's conversation.
    const nested = await writeRollout(OTHER_ROOT_ID, sessionMeta(OTHER_ROOT_ID));
    const run = runner(await lsofFor([{ pid: 104, fd: "12", access: "w", name: nested }]));

    await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
      status: "unknown",
      reason: "not-observed",
    });
  });

  it("names none when the pane's Codex holds two root sessions", async () => {
    const a = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID));
    const b = await writeRollout(OTHER_ROOT_ID, sessionMeta(OTHER_ROOT_ID));
    const run = runner(
      await lsofFor([
        { fd: "37", access: "u", name: a },
        { fd: "12", access: "w", name: b },
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
        { fd: "20", access: "w", name: file },
        { fd: "37", access: "u", name: file },
      ])
    );

    const result = await probeCodexSessionFile(100, { platform: "darwin", run });
    expect(result).toMatchObject({ status: "observed", sessionId: ROOT_ID });
  });

  it("ignores rollouts open only for reading", async () => {
    const file = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID));
    const run = runner(await lsofFor([{ fd: "37", access: "r", name: file }]));

    await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
      status: "unknown",
      reason: "not-observed",
    });
  });

  it.each([
    ["inode", { inode: "1" }],
    ["device", { device: "0x1" }],
    ["device, unreadable", { device: "" }],
  ])("refuses a path whose %s isn't the file lsof saw", async (_label, listed) => {
    const file = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID));
    const run = runner(await lsofFor([{ fd: "37", access: "u", name: file, ...listed }]));

    await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
      status: "unknown",
      reason: "unverified",
    });
  });

  it("refuses a symlink planted where the rollout was", async () => {
    const real = path.join(codexHome, "elsewhere.jsonl");
    await writeFile(real, `${sessionMeta(ROOT_ID)}\n`);
    const link = rolloutPath(ROOT_ID);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(real, link);
    const run = runner(await lsofFor([{ fd: "37", access: "u", name: link }]));

    await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
      status: "unknown",
      reason: "unverified",
    });
  });

  it("refuses a subagent's rollout with no root beside it", async () => {
    const child = await writeRollout(CHILD_ID, sessionMeta(CHILD_ID, { session_id: ROOT_ID }));
    const run = runner(await lsofFor([{ fd: "41", access: "w", name: child }]));

    await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
      status: "unknown",
      reason: "unverified",
    });
  });

  it("refuses a rollout whose first record has not ended yet", async () => {
    const file = rolloutPath(ROOT_ID);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, sessionMeta(ROOT_ID));
    const run = runner(await lsofFor([{ fd: "37", access: "u", name: file }]));

    await expect(probeCodexSessionFile(100, { platform: "darwin", run })).resolves.toEqual({
      status: "unknown",
      reason: "unverified",
    });
  });

  it("drops the listing when the process it listed was replaced under it", async () => {
    const file = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID));
    const lsof = await lsofFor([{ fd: "37", access: "u", name: file }]);
    for (const recheck of [
      { stdout: censusLine(102, 101, NATIVE, "Mon Nov  2 05:00:00 2026"), exitCode: 0 },
      { stdout: censusLine(102, 1, NATIVE), exitCode: 0 },
      { stdout: "", exitCode: 1 },
    ]) {
      await expect(
        probeCodexSessionFile(100, { platform: "darwin", run: runner(lsof, { recheck }) })
      ).resolves.toEqual({ status: "unknown", reason: "pane-changed" });
    }
  });

  it("fails closed on any listing that didn't finish cleanly", async () => {
    const file = await writeRollout(ROOT_ID, sessionMeta(ROOT_ID));
    const lsof = await lsofFor([{ fd: "37", access: "u", name: file }]);
    const missing = Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
    const cases: Overrides[] = [
      { lsof: missing },
      // Exit 1 can mean a file it couldn't inspect, not only a process that went.
      { lsof: { stdout: lsof, exitCode: 1 } },
      { census: { stdout: PS_TREE, exitCode: 1 } },
      { census: new Error("ps timed out") },
    ];
    for (const overrides of cases) {
      await expect(
        probeCodexSessionFile(100, { platform: "linux", run: runner(lsof, overrides) })
      ).resolves.toEqual({ status: "unknown", reason: "probe-failed" });
    }
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

describe.skipIf(process.platform === "win32")("runListing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Running, by `ps`: a zombie no one has reaped yet counts as gone. */
  function alive(pid: number): boolean {
    try {
      const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
      return state.trim() !== "" && !state.trim().startsWith("Z");
    } catch {
      return false;
    }
  }

  it("hands back the output and the exit status, signalling nothing once it has exited", async () => {
    const kill = vi.spyOn(process, "kill");
    await expect(
      runListing("sh", ["-c", "printf 'p1\\n'; exit 1"], { timeoutMs: 5_000, maxBytes: 1024 })
    ).resolves.toEqual({ stdout: "p1\n", exitCode: 1 });
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills the whole group, once, when the listing runs out of time", async () => {
    const pidFile = path.join(codexHome, "helper.pid");
    // The helper reports in before the deadline and outlives the shell unless
    // its group is killed with it.
    const script = `sleep 30 & echo $! > '${pidFile}'; wait`;
    const kill = vi.spyOn(process, "kill");
    let helper: number | null = null;
    try {
      await expect(
        runListing("sh", ["-c", script], { timeoutMs: 1_500, maxBytes: 1024 })
      ).rejects.toThrow(/timed out/);
      helper = Number((await readFile(pidFile, "utf8")).trim());
      await vi.waitFor(() => expect(alive(helper as number)).toBe(false), { timeout: 5_000 });
      // With every member gone the listing has closed too, so a late signal would be in by now.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(kill.mock.calls.filter(([pid]) => pid < 0)).toHaveLength(1);
    } finally {
      if (helper !== null && alive(helper)) process.kill(helper, "SIGKILL");
    }
  });

  it("refuses output past its cap", async () => {
    await expect(
      runListing("sh", ["-c", "yes"], { timeoutMs: 5_000, maxBytes: 64 * 1024 })
    ).rejects.toThrow(/cap/);
  });

  it("rejects when the command can't start", async () => {
    await expect(
      runListing("daintree-no-such-listing", [], { timeoutMs: 1_000, maxBytes: 1024 })
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

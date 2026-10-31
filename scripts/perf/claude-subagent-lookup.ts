// Node-level benchmark for locating a Claude session's `subagents/` directory (#15669).
//   npm run perf claude-subagent-lookup -- [--dirs 700] [--rounds 15] [--lookups 40] [--json]
//
// Builds a throwaway projects root shaped like a worktree-heavy ~/.claude/projects
// and drives `findSubagentsDir` the way the 5 s subagent poll does, one lookup
// at a time. Per lookup it reports the Node filesystem requests issued (libuv fs
// requests counted through async_hooks, so the count does not depend on how the
// reader imports `fs`; not a count of OS syscalls) and the event-loop-active
// time it cost, as the median of `--rounds` batches of `--lookups` sequential
// lookups. Requests are counted in a pass of their own: the hook slows every
// async resource, so it is off while anything is timed.
//
// Mechanism, not journey: it removes the IPC hop, the pty-host terminal lookup
// and the renderer poll, and the fixture's directories are empty apart from a
// few transcripts, so a real store with deeper trees and a slower disk pays more
// per `stat`. The counts carry across machines; the times are this machine's.
import { createHook } from "node:async_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    dirs: { type: "string", default: "700" },
    rounds: { type: "string", default: "15" },
    lookups: { type: "string", default: "40" },
    json: { type: "boolean", default: false },
  },
});
const dirCount = Number(values.dirs);
const rounds = Number(values.rounds);
const lookups = Number(values.lookups);
if (![dirCount, rounds, lookups].every((n) => Number.isInteger(n) && n > 0)) {
  console.error("--dirs, --rounds and --lookups must be positive integers");
  process.exit(2);
}

const reader = await import("../../electron/services/claude/ClaudeSubagentReader.js");
const { deriveProjectSlug, findSubagentsDir } = reader;
// Clears the remembered scan locations along with the reader's other caches,
// so the cold reading is a first look. On a tree that predates the location
// memo there is nothing to clear, and cold reads the same as warm.
const resetCaches = (reader as Record<string, unknown>).__resetClaudeSubagentCaches as
  | (() => void)
  | undefined;

let fsRequests = 0;
const requestCounter = createHook({
  init(_id, type) {
    if (type === "FSREQPROMISE" || type === "FSREQCALLBACK") fsRequests += 1;
  },
});

const configDir = await mkdtemp(path.join(tmpdir(), "claude-subagent-lookup-"));
const projectsRoot = path.join(configDir, "projects");
const worktreeCwd = (i: number) => `/Users/dev/Projects/app-worktrees/feature-issue-${10_000 + i}`;
const sessionId = (tag: string) => `${tag.padEnd(8, "0").slice(0, 8)}-0000-4000-8000-000000000000`;

interface Case {
  name: string;
  summary: string;
  cwd: string;
  sessionId: string;
  expected: string | null;
}

async function buildFixture(): Promise<Case[]> {
  await mkdir(projectsRoot, { recursive: true });
  // Every project directory holds a couple of unrelated transcripts, as real ones do.
  for (let i = 0; i < dirCount; i++) {
    const dir = path.join(projectsRoot, deriveProjectSlug(worktreeCwd(i)));
    await mkdir(dir);
    await writeFile(path.join(dir, `${sessionId(`a${i}`)}.jsonl`), "{}\n");
    await writeFile(path.join(dir, `${sessionId(`b${i}`)}.jsonl`), "{}\n");
  }

  const middle = Math.floor(dirCount / 2);
  const workingCwd = worktreeCwd(middle);
  const workingDir = path.join(projectsRoot, deriveProjectSlug(workingCwd));

  // Working, nothing delegated yet: the transcript is where the slug rule says,
  // and there is no `<sid>/subagents` anywhere.
  const noChildren = sessionId("c0ffee");
  await writeFile(path.join(workingDir, `${noChildren}.jsonl`), "{}\n");

  // A child already running, in the directory the slug rule predicts.
  const directHit = sessionId("d1rec7");
  const directSubagents = path.join(workingDir, directHit, "subagents");
  await mkdir(directSubagents, { recursive: true });
  await writeFile(path.join(workingDir, `${directHit}.jsonl`), "{}\n");
  await writeFile(path.join(directSubagents, "agent-a1.jsonl"), "{}\n");

  // A path the slug rule gets wrong (Claude hashes very long names): the
  // session lives under a directory only the scan can find.
  const fallbackCwd = `/Users/dev/Projects/${"very-long-segment-".repeat(14)}app`;
  const fallbackOnly = sessionId("fa11bac");
  const hashedDir = path.join(projectsRoot, `${deriveProjectSlug(fallbackCwd).slice(0, 200)}-1x2y3z`);
  const fallbackSubagents = path.join(hashedDir, fallbackOnly, "subagents");
  await mkdir(fallbackSubagents, { recursive: true });
  await writeFile(path.join(hashedDir, `${fallbackOnly}.jsonl`), "{}\n");
  await writeFile(path.join(fallbackSubagents, "agent-b2.jsonl"), "{}\n");

  // Nowhere in this store: a pane whose agent writes to another config dir, or
  // a session that has not recorded its first message yet.
  const absent = sessionId("ab5e47");

  return [
    {
      name: "no-children",
      summary: "working session, transcript under the derived slug, no subagents/ yet",
      cwd: workingCwd,
      sessionId: noChildren,
      expected: null,
    },
    {
      name: "fallback-hit",
      summary: "subagents/ only under a slug the derivation gets wrong",
      cwd: fallbackCwd,
      sessionId: fallbackOnly,
      expected: fallbackSubagents,
    },
    {
      name: "direct-hit",
      summary: "subagents/ under the derived slug",
      cwd: workingCwd,
      sessionId: directHit,
      expected: directSubagents,
    },
    {
      name: "absent",
      summary: "session not in this store at all",
      cwd: worktreeCwd(dirCount + 1),
      sessionId: absent,
      expected: null,
    },
  ];
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface CaseResult {
  name: string;
  summary: string;
  coldFsRequests: number;
  fsRequestsPerLookup: number;
  activeMsPerLookup: number;
  wallMsPerLookup: number;
}

async function lookup(c: Case): Promise<void> {
  const found = await findSubagentsDir(c.cwd, c.sessionId, { configDir });
  // The correctness predicate: a faster lookup that answers differently is a
  // regression, not a result.
  if (found !== c.expected) {
    throw new Error(`${c.name}: expected ${String(c.expected)}, got ${String(found)}`);
  }
}

async function countRequests(c: Case): Promise<number> {
  const before = fsRequests;
  await lookup(c);
  return fsRequests - before;
}

async function measure(c: Case): Promise<CaseResult> {
  resetCaches?.();
  requestCounter.enable();
  const coldFsRequests = await countRequests(c);
  const requestSamples: number[] = [];
  for (let i = 0; i < lookups; i++) requestSamples.push(await countRequests(c));
  requestCounter.disable();

  for (let i = 0; i < 5; i++) await lookup(c);
  const activeSamples: number[] = [];
  const wallSamples: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const elu = performance.eventLoopUtilization();
    const started = performance.now();
    for (let i = 0; i < lookups; i++) await lookup(c);
    const wall = performance.now() - started;
    const delta = performance.eventLoopUtilization(elu);
    activeSamples.push(delta.active / lookups);
    wallSamples.push(wall / lookups);
  }
  return {
    name: c.name,
    summary: c.summary,
    coldFsRequests,
    fsRequestsPerLookup: median(requestSamples),
    activeMsPerLookup: median(activeSamples),
    wallMsPerLookup: median(wallSamples),
  };
}

let exitCode = 0;
try {
  const cases = await buildFixture();
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await measure(c));

  if (values.json) {
    console.log(JSON.stringify({ dirs: dirCount, rounds, lookups, results }, null, 2));
  } else {
    console.log(
      `${dirCount + 1} project directories, median of ${rounds} rounds x ${lookups} lookups`
    );
    for (const r of results) {
      console.log(
        `${r.name.padEnd(13)} fs requests/lookup ${r.fsRequestsPerLookup.toFixed(1).padStart(6)}` +
          ` (cold ${String(r.coldFsRequests).padStart(4)})` +
          `  active ${r.activeMsPerLookup.toFixed(3)} ms  wall ${r.wallMsPerLookup.toFixed(3)} ms` +
          `  — ${r.summary}`
      );
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await rm(configDir, { recursive: true, force: true });
}
process.exit(exitCode);

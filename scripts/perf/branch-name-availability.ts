// Node-level benchmark for the New Worktree dialog's branch-name check (#15663).
//   npm run perf branch-name-availability -- [--refs 300,3000,20000] [--calls 9] [--json]
//
// Builds one throwaway repository per size, shaped like a long-lived company
// repo that never prunes: a few local branches and every other ref a
// remote-tracking branch, each with its own tip commit, refs packed as after a
// `git gc`. It then drives `GitService.findAvailableBranchName()` the way the
// dialog's debounced check does, one call at a time, beside a `legacy` arm that
// answers from `listBranches()` the way the method did before #15663. Per call
// it reports wall time, git processes started, bytes git wrote to stdout, and
// the longest stretch the calling thread went unobserved (lib/bystander.ts),
// as medians over every timed call. The stall reading at 4 ms cadence cannot
// resolve anything shorter than a cadence.
//
// The oracle runs on every call of both arms: a free name, a name taken
// locally, a name taken only on a remote, and a name with local `-2`/`-7`
// suffixes beside a larger remote one. A faster answer that differs is a
// regression, not a result.
//
// Mechanism, not journey: no IPC hop, no renderer debounce, and the fixture's
// commits are tiny, so a real repository pays more per tip that `git branch -v`
// reads. Spawn and byte counts carry across machines; the times are this one's.
import { ChildProcess, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { armBystanderProbe } from "./lib/bystander.js";
import { createPerfTempRoot } from "./lib/tempRoots.js";

const { values } = parseArgs({
  options: {
    refs: { type: "string", default: "300,3000,20000" },
    calls: { type: "string", default: "9" },
    json: { type: "boolean", default: false },
  },
});
const sizes = values.refs.split(",").map((s) => Number(s.trim()));
const calls = Number(values.calls);
if (!sizes.every((n) => Number.isInteger(n) && n >= 100) || !Number.isInteger(calls) || calls < 1) {
  console.error("--refs takes comma-separated integers >= 100; --calls a positive integer");
  process.exit(2);
}

// The logger picks its file destination from this at module evaluation.
process.env.DAINTREE_USER_DATA ??= createPerfTempRoot("branch-name-availability-userdata-");
const { GitService } = await import("../../electron/services/GitService.js");
type Service = InstanceType<typeof GitService>;

// Every async child process goes through ChildProcess.prototype.spawn; fixture
// setup uses execFileSync (spawnSync), which does not, so it is never counted.
let gitSpawns = 0;
let gitStdoutBytes = 0;
const proto = ChildProcess.prototype as unknown as {
  spawn: (this: ChildProcess, options: { file?: string }) => unknown;
};
const originalSpawn = proto.spawn;
proto.spawn = function (this: ChildProcess, options: { file?: string }) {
  const result = originalSpawn.call(this, options);
  const file = (options?.file ?? "").toLowerCase();
  const base = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  if (base === "git" || base === "git.exe") {
    gitSpawns += 1;
    this.stdout?.on("data", (chunk: Buffer) => {
      gitStdoutBytes += chunk.length;
    });
  }
  return result;
};

/** What `findAvailableBranchName()` answered before #15663, kept as the control arm. */
async function legacyFindAvailableBranchName(service: Service, baseName: string): Promise<string> {
  const branches = await service.listBranches();
  const local = new Set(branches.filter((b) => !b.remote).map((b) => b.name));
  if (!local.has(baseName)) return baseName;
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let maxSuffix = 1;
  for (const name of local) {
    const match = name.match(new RegExp(`^${escaped}-(\\d+)$`));
    if (match) maxSuffix = Math.max(maxSuffix, parseInt(match[1]!, 10));
  }
  return `${baseName}-${maxSuffix + 1}`;
}

interface OracleCase {
  name: string;
  input: string;
  expected: string;
}

const ORACLE: OracleCase[] = [
  { name: "free", input: "bench/free-name", expected: "bench/free-name" },
  { name: "taken-locally", input: "bench/taken", expected: "bench/taken-2" },
  { name: "remote-only", input: "bench/remote-only", expected: "bench/remote-only" },
  { name: "suffixed", input: "bench/suffixed", expected: "bench/suffixed-8" },
];

const ORACLE_LOCAL = [
  "bench/taken",
  "bench/suffixed",
  "bench/suffixed-2",
  "bench/suffixed-7",
  // Look like suffixes and are not: neither may move the answer.
  "bench/suffixed-9-old",
  "bench/suffixed-11/nested",
];
const ORACLE_REMOTE = ["origin/bench/remote-only", "origin/bench/suffixed-30", "origin/bench/taken"];

/** Local branch count for a fixture: a few, growing slowly with the repo. */
function localCount(totalRefs: number): number {
  return Math.min(200, Math.max(10, Math.round(totalRefs * 0.05)));
}

function buildFixture(totalRefs: number): string {
  const repo = createPerfTempRoot(`branch-name-availability-${totalRefs}-`);
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: repo, input, stdio: ["pipe", "ignore", "pipe"] });
  git(["init", "-q", "-b", "main"]);

  const locals = localCount(totalRefs);
  const remotes = totalRefs - locals - ORACLE_LOCAL.length - ORACLE_REMOTE.length - 2;
  const refs: string[] = [];
  for (const name of ORACLE_LOCAL) refs.push(`refs/heads/${name}`);
  for (let i = 0; i < locals; i++) refs.push(`refs/heads/dev/topic-${i}`);
  for (const name of ORACLE_REMOTE) refs.push(`refs/remotes/${name}`);
  refs.push("refs/remotes/origin/main");
  for (let i = 0; i < remotes; i++) {
    refs.push(`refs/remotes/origin/team-${i % 40}/feature-${String(i).padStart(6, "0")}`);
  }

  // One fast-import stream: a root commit on main, then a distinct child commit
  // per ref, so `git branch -v` has a different tip subject to read for each.
  const chunks: string[] = [];
  const commit = (ref: string, subject: string, ts: number, from?: string) => {
    chunks.push(
      `commit ${ref}\n`,
      ...(from ? [] : ["mark :1\n"]),
      `committer Bench <bench@example.invalid> ${ts} +0000\n`,
      `data ${Buffer.byteLength(subject)}\n${subject}\n`,
      ...(from ? [`from ${from}\n`] : []),
      "\n"
    );
  };
  commit("refs/heads/main", "Initial commit", 1_700_000_000);
  refs.forEach((ref, i) =>
    commit(ref, `Work on ${ref.slice(ref.lastIndexOf("/") + 1)} (${i})`, 1_700_000_100 + i, ":1")
  );
  git(["fast-import", "--quiet"], chunks.join(""));
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(["pack-refs", "--all"]);

  const counted = execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: repo })
    .toString()
    .trim()
    .split("\n").length;
  if (counted !== totalRefs + 1) {
    throw new Error(`fixture has ${counted} refs, expected ${totalRefs + 1} (with main)`);
  }
  return repo;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

type Arm = "legacy" | "current";
const ARMS: Record<Arm, (service: Service, input: string) => Promise<string>> = {
  legacy: legacyFindAvailableBranchName,
  current: (service, input) => service.findAvailableBranchName(input),
};

interface ArmResult {
  arm: Arm;
  wallMsPerCall: number;
  gitSpawnsPerCall: number;
  gitStdoutBytesPerCall: number;
  longestStallMsPerCall: number;
  longestStallMsMax: number;
}

interface SizeResult {
  refs: number;
  localBranches: number;
  arms: ArmResult[];
}

async function check(arm: Arm, service: Service, c: OracleCase): Promise<void> {
  const answer = await ARMS[arm](service, c.input);
  if (answer !== c.expected) {
    throw new Error(`${arm} ${c.name}: expected ${c.expected}, got ${answer}`);
  }
}

async function measureArm(arm: Arm, service: Service): Promise<ArmResult> {
  for (const c of ORACLE) await check(arm, service, c);
  const wall: number[] = [];
  const spawns: number[] = [];
  const bytes: number[] = [];
  const stalls: number[] = [];
  for (let round = 0; round < calls; round++) {
    for (const c of ORACLE) {
      const probe = await armBystanderProbe({ cadenceMs: 4 });
      const spawnsBefore = gitSpawns;
      const bytesBefore = gitStdoutBytes;
      const started = performance.now();
      await check(arm, service, c);
      wall.push(performance.now() - started);
      const reading = probe.stop();
      if (reading.probeMisses > 0) throw new Error("bystander probe never armed");
      spawns.push(gitSpawns - spawnsBefore);
      bytes.push(gitStdoutBytes - bytesBefore);
      stalls.push(reading.longestStallMs);
    }
  }
  // Every call of either arm starts git, so a zero means the spawn hook missed it.
  if (spawns.some((n) => n === 0)) throw new Error(`${arm}: spawn counter observed no git start`);
  return {
    arm,
    wallMsPerCall: median(wall),
    gitSpawnsPerCall: median(spawns),
    gitStdoutBytesPerCall: median(bytes),
    longestStallMsPerCall: median(stalls),
    longestStallMsMax: Math.max(...stalls),
  };
}

/** The probe's floor: the same reading over an idle window, nothing running. */
async function idleControlMs(): Promise<number> {
  const stalls: number[] = [];
  for (let i = 0; i < 20; i++) {
    const probe = await armBystanderProbe({ cadenceMs: 4 });
    await new Promise((resolve) => setTimeout(resolve, 8));
    stalls.push(probe.stop().longestStallMs);
  }
  return median(stalls);
}

const versions = {
  node: process.version,
  git: execFileSync("git", ["--version"]).toString().trim(),
  simpleGit: (
    JSON.parse(
      readFileSync(new URL("../../node_modules/simple-git/package.json", import.meta.url), "utf8")
    ) as { version: string }
  ).version,
};
const idleStallMs = await idleControlMs();
const results: SizeResult[] = [];
for (const totalRefs of sizes) {
  const repo = buildFixture(totalRefs);
  const service = new GitService(repo);
  const arms: ArmResult[] = [];
  for (const arm of Object.keys(ARMS) as Arm[]) arms.push(await measureArm(arm, service));
  results.push({ refs: totalRefs, localBranches: localCount(totalRefs) + ORACLE_LOCAL.length, arms });
}
proto.spawn = originalSpawn;

if (values.json) {
  console.log(JSON.stringify({ versions, calls, idleStallMs, oracle: ORACLE, results }, null, 2));
} else {
  console.log(
    `findAvailableBranchName(), median of ${calls} rounds x ${ORACLE.length} oracle cases; ` +
      `oracle passed on every call (${ORACLE.map((c) => c.name).join(", ")})`
  );
  console.log(
    `${versions.git}, Node ${versions.node}, simple-git ${versions.simpleGit}; ` +
      `idle control longest stall ${idleStallMs.toFixed(1)} ms`
  );
  for (const r of results) {
    console.log(`\n${r.refs} refs (${r.localBranches} local)`);
    for (const a of r.arms) {
      console.log(
        `  ${a.arm.padEnd(8)} wall ${a.wallMsPerCall.toFixed(2).padStart(8)} ms` +
          `  git spawns ${String(a.gitSpawnsPerCall).padStart(2)}` +
          `  stdout ${String(a.gitStdoutBytesPerCall).padStart(9)} B` +
          `  longest stall ${a.longestStallMsPerCall.toFixed(1).padStart(6)} ms` +
          ` (max ${a.longestStallMsMax.toFixed(1)})`
      );
    }
  }
}

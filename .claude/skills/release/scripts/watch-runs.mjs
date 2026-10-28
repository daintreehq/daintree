#!/usr/bin/env node
// Bounded watch over release runs: polls until every run is terminal, a job
// newly fails, or the time window ends, then prints one line per run plus the
// four update feeds. Network and API errors are retried, never read as a run
// failing (gh run watch exits non-zero on a dropped connection, which looks
// like a red run).
//
// Usage: node watch-runs.mjs --runs <id,id,...> [--minutes 9] [--version X.Y.Z]
// Exits 0 when every run is terminal, 4 when a job failed or was cancelled
// since the call started (triage it now; the runs keep going), 3 when the
// window ended first. Call it again to keep watching; each call fits inside
// one Bash timeout. Job timeouts report "cancelled": run-failures.mjs tells
// them apart.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (!argv[i]?.startsWith("--") || !(key in spec) || value === undefined || value.startsWith("--")) {
      console.error(`bad argument near ${argv[i] ?? "(end)"}; accepted: ${Object.keys(spec).map((k) => `--${k}`).join(" ")}`);
      process.exit(2);
    }
    out[key] = value;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2), { runs: 1, minutes: 1, version: 1, repo: 1 });
const ids = (args.runs ?? "").split(",").filter(Boolean);
const minutes = Number(args.minutes ?? 9);
if (!ids.length || !Number.isFinite(minutes) || minutes <= 0) {
  console.error("usage: watch-runs.mjs --runs <id,id,...> [--minutes 9] [--version X.Y.Z]");
  process.exit(2);
}
const repo = args.repo ?? "daintreehq/daintree";
const deadline = Date.now() + minutes * 60_000;
const FEEDS = ["latest-mac.yml", "latest-linux.yml", "latest-linux-arm64.yml", "latest.yml"];
const BAD = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tryJson(a) {
  try {
    const { stdout } = await execFileAsync("gh", a, { encoding: "utf8", maxBuffer: 64 << 20, timeout: 30_000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
async function snapshot(id) {
  const run = await tryJson(["run", "view", id, "--repo", repo, "--json", "status,conclusion,workflowName,attempt,jobs"]);
  if (!run) return { id, line: `${id}: (API unreachable, retrying)`, terminal: false, bad: [] };
  const jobs = run.jobs ?? [];
  const done = jobs.filter((j) => j.status === "completed").length;
  const bad = jobs.filter((j) => BAD.has(j.conclusion)).map((j) => `${j.name} (${j.conclusion})`);
  const running = jobs.filter((j) => j.status === "in_progress").map((j) => j.name);
  const queued = jobs.length && jobs.every((j) => j.status === "queued" || j.status === "waiting");
  const state = run.status === "completed" ? run.conclusion : queued ? "queued" : `${done}/${jobs.length} jobs done`;
  const parts = [`${run.workflowName} ${id} (attempt ${run.attempt}): ${state}`];
  if (bad.length) parts.push(`failed or cancelled: ${bad.join("; ")}`);
  if (run.status !== "completed" && running.length) parts.push(`running: ${running.slice(0, 3).join("; ")}${running.length > 3 ? ` +${running.length - 3}` : ""}`);
  return { id, line: parts.join(" | "), terminal: run.status === "completed", bad };
}
async function feeds() {
  return (
    await Promise.all(
      FEEDS.map(async (feed) => {
        try {
          const res = await fetch(`https://updates.daintree.org/releases/${feed}?t=${Date.now()}`, { signal: AbortSignal.timeout(10_000) });
          const version = (await res.text()).match(/^version:\s*(\S+)/m)?.[1] ?? "?";
          return `${feed} ${version}${args.version && version === args.version ? " ✓" : ""}`;
        } catch {
          return `${feed} (unreachable)`;
        }
      })
    )
  ).join(", ");
}

let snaps = await Promise.all(ids.map(snapshot));
const seenBad = new Set(snaps.flatMap((s) => s.bad.map((b) => `${s.id}:${b}`)));
let exit = 3;
for (;;) {
  if (snaps.every((s) => s.terminal)) {
    exit = 0;
    break;
  }
  if (snaps.some((s) => s.bad.some((b) => !seenBad.has(`${s.id}:${b}`)))) {
    exit = 4;
    break;
  }
  const left = deadline - Date.now();
  if (left <= 0) break;
  await sleep(Math.min(45_000, left));
  snaps = await Promise.all(ids.map(snapshot));
}
console.log(new Date().toISOString().slice(11, 16) + " UTC");
for (const s of snaps) console.log(s.line);
console.log(await feeds());
if (exit === 4) console.log("A job failed or was cancelled since this watch started: run run-failures.mjs on that run now.");
process.exit(exit);

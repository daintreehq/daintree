#!/usr/bin/env node
/**
 * Drive ONE real turn through the assistant engine and report what it emitted.
 *
 * No Electron, no Playwright, no window: this speaks the same stdio NDJSON protocol the
 * panel speaks, so anything it reproduces is something the panel sees. It is the cheapest
 * way to answer "is this the engine or the renderer?", which is the question that decides
 * where a fix belongs.
 *
 * Usage:
 *   node e2e/local/assistant-turn.mjs "Please create a claude code terminal"
 *   node e2e/local/assistant-turn.mjs --clear "…"     also send /clear at the end
 *   node e2e/local/assistant-turn.mjs --raw "…"       dump every frame
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BACKEND = process.env.DAINTREE_BACKEND_URL?.trim() || "http://127.0.0.1:8473";
// Pinned to the constant the app ships, so a protocol bump fails this harness loudly
// rather than letting it test a version nothing runs.
const PROTOCOL_VERSION = 4;
const TURN_TIMEOUT_MS = Number(process.env.ASSISTANT_TURN_TIMEOUT_MS ?? 240_000);

const args = process.argv.slice(2);
const alsoClear = args.includes("--clear");
const raw = args.includes("--raw");
const prompt = args
  .filter((a) => !a.startsWith("--"))
  .join(" ")
  .trim();
if (!prompt) {
  console.error('usage: node e2e/local/assistant-turn.mjs [--clear] [--raw] "<prompt>"');
  process.exit(2);
}

const bin =
  process.env.DAINTREE_ASSISTANT_BIN?.trim() ||
  path.join(REPO, "resources/assistant", `daintree-assistant-${process.platform}-${process.arch}`);
if (!existsSync(bin)) {
  console.error(`No engine at ${bin}\nBuild it with: npm run build:assistant`);
  process.exit(2);
}

// Deliberately NO MCP credentials: this harness exercises the model loop and the wire,
// not the Daintree control plane. A tool call that needs MCP will report it is not
// connected, which is itself a legible result rather than a hang.
const child = spawn(bin, ["host", "--stdio"], {
  cwd: REPO,
  env: {
    ...process.env,
    DAINTREE_BACKEND_URL: BACKEND,
    DAINTREE_ASSISTANT_TIER: process.env.DAINTREE_ASSISTANT_TIER ?? "system",
    DAINTREE_ASSISTANT_AUTO_APPROVE: "1",
    DAINTREE_ASSISTANT_DEBUG_LOG: "1",
    DAINTREE_PROJECT_ID: "local-harness",
    DAINTREE_WINDOW_ID: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

// The descriptor is the FIRST stdin line — the engine validates it before it will
// emit anything at all, including host:ready. Without it the process sits silent, which
// is exactly what a harness that skipped it saw.
const SESSION_ID = "ses_local_harness";
const DESCRIPTOR = {
  sessionId: SESSION_ID,
  windowId: 1,
  projectId: "local-harness",
  cwd: REPO,
  tier: "system",
  protocolVersion: PROTOCOL_VERSION,
};

let sessionId = null;
let logFile = null;
const counts = new Map();
const preambles = [];
const batches = [];
let text = "";
let turnsEnded = 0;
/** Set the moment anything parses, so "the engine said nothing" is distinguishable. */
let sawFrames = false;
/** Non-zero on any path where this harness cannot honestly report success. */
let exitCode = 0;
let timedOut = false;

// Token arrival timing. "Is it streaming?" is not answerable by looking at the final
// text — a single chunk carrying the whole answer and a thousand chunks carrying a word
// each produce identical prose. Only the SHAPE of arrival tells them apart, so record it.
const tokenFrames = [];
let promptSentAt = 0;

const bump = (t) => counts.set(t, (counts.get(t) ?? 0) + 1);
const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

child.stderr.on("data", (d) => process.stderr.write(`[engine] ${d}`));

send(DESCRIPTOR);

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    // A line that is not JSON is a PROTOCOL violation, not noise to skip past. The
    // engine's stdout carries frames and nothing else; anything else on it means a
    // print statement is corrupting the stream, which is exactly the failure a harness
    // that shrugged at it would hide.
    console.log(`MALFORMED FRAME: ${line.slice(0, 200)}`);
    exitCode = 1;
    return;
  }
  if (raw) console.log(line);
  bump(ev.type);
  sawFrames = true;

  switch (ev.type) {
    case "host:ready":
      sessionId = ev.sessionId;
      logFile = ev.logFile ?? null;
      console.log(`ready · tier=${ev.tier} · backend=${ev.backend ?? "(default)"}`);
      if (logFile) console.log(`log   · ${logFile}`);
      setTimeout(() => {
        promptSentAt = Date.now();
        send({ type: "prompt", sessionId, text: prompt });
      }, 250);
      break;
    case "turn:token":
      tokenFrames.push({ at: Date.now(), len: (ev.chunk ?? "").length });
      text += ev.chunk ?? "";
      break;
    case "tool:batch":
      // The signature of the reported bug: the same batch announced over and over.
      batches.push((ev.calls ?? []).map((c) => c.toolId).join("+"));
      // Whatever prose had streamed before this batch is one "preamble".
      if (text.trim()) preambles.push(text.trim());
      text = "";
      break;
    case "turn:end":
      // A prompt produces TWO brackets: the user's own turn, which opens and closes in
      // the same millisecond carrying no outcome, and then the assistant's. Only the
      // second one ends the run. Treating the first as terminal killed the engine
      // mid-turn and logged it as "Turn cancelled" — a defect in this harness that
      // looked exactly like a defect in the engine.
      if (!ev.outcome) break;
      turnsEnded++;
      if (text.trim()) preambles.push(text.trim());
      text = "";
      console.log(`turn ended · outcome=${ev.outcome}`);
      finish();
      break;
    case "notice":
      console.log(`notice[${ev.level}] ${ev.message}`);
      break;
    // Both spellings: the engine emits `host:error` for a fatal boot/protocol failure
    // and `error` for an in-session one. Listening for only the second meant a session
    // that never started at all was reported as a clean run.
    case "host:error":
    case "error":
      console.log(`ERROR ${ev.code ?? ""} ${ev.message ?? ""}`);
      exitCode = 1;
      break;
  }
});

let finished = false;
function finish() {
  if (finished) return;
  finished = true;

  // The token-arrival shape, reported as its own block because "the text was right" and
  // "the text streamed" are separate claims and only one of them is visible in the prose.
  const reportStreaming = () => {
    console.log("\n─── token streaming ───");
    if (tokenFrames.length === 0) {
      console.log("  NO turn:token frames at all — the turn produced text only on");
      console.log("  turn:end, so nothing could stream. Look at the backend's SSE.");
      return;
    }
    const total = tokenFrames.reduce((n, f) => n + f.len, 0);
    const first = tokenFrames[0].at - promptSentAt;
    const last = tokenFrames[tokenFrames.length - 1].at;
    const span = last - tokenFrames[0].at;
    const gaps = tokenFrames.slice(1).map((f, i) => f.at - tokenFrames[i].at);
    const maxGap = gaps.length ? Math.max(...gaps) : 0;
    // How much of the answer landed in the single largest frame. One frame carrying
    // most of it is the signature of a buffered backend pretending to stream.
    const biggest = Math.max(...tokenFrames.map((f) => f.len));
    const share = total > 0 ? Math.round((biggest / total) * 100) : 0;
    console.log(`  frames            ${tokenFrames.length}`);
    console.log(`  chars             ${total} (largest frame ${biggest}, ${share}% of the answer)`);
    console.log(`  first token       ${first}ms after the prompt`);
    console.log(`  streamed over     ${span}ms (largest gap ${maxGap}ms)`);
    if (tokenFrames.length < 5 || share > 60) {
      console.log("  VERDICT: NOT streaming — the answer arrived in essentially one piece.");
    } else if (span < 150) {
      console.log("  VERDICT: NOT streaming — every frame landed inside one animation frame,");
      console.log("  so a renderer coalescing per frame paints it all at once regardless.");
    } else {
      console.log("  VERDICT: streaming. The renderer receives it incrementally.");
    }
  };

  const verdict = () => {
    // The harness cannot claim a clean run unless a turn actually happened. Every one
    // of these was previously a silent pass: no engine output at all, a session that
    // never became ready, a prompt that was never sent, a turn that never ended, or a
    // turn that ended having produced nothing.
    const problems = [];
    if (!sawFrames) problems.push("the engine emitted nothing at all");
    if (!sessionId) problems.push("the session never became ready");
    if (!promptSentAt) problems.push("the prompt was never sent");
    if (timedOut) problems.push("timed out waiting for the turn");
    else if (turnsEnded === 0) problems.push("no assistant turn ever ended");
    if (turnsEnded > 0 && preambles.length === 0 && batches.length === 0) {
      problems.push("the turn ended having produced neither prose nor a tool call");
    }
    if (problems.length > 0) {
      exitCode = 1;
      console.log("\n─── this run proves nothing ───");
      for (const p of problems) console.log(`  · ${p}`);
    }
  };

  const report = () => {
    console.log("\n─── what the ENGINE emitted ───");
    for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${t}`);
    }

    reportStreaming();

    console.log(`\nturn:end          ${turnsEnded}`);
    console.log(`tool:batch        ${batches.length}`);
    const uniqueBatches = new Set(batches);
    console.log(`distinct batches  ${uniqueBatches.size}`);
    const uniquePreambles = new Set(preambles.map((p) => p.slice(0, 120)));
    console.log(`prose segments    ${preambles.length} (${uniquePreambles.size} distinct)`);

    // The verdict this harness exists for.
    const repeated =
      (batches.length > 1 && uniqueBatches.size === 1) ||
      (preambles.length > 1 && uniquePreambles.size < preambles.length);
    console.log("\n─── verdict ───");
    if (repeated) {
      console.log("REPEAT IN THE ENGINE — the same work was emitted more than once on the");
      console.log("wire, before any renderer touched it. Fix belongs in the engine or the");
      console.log("backend, not the panel.");
      for (const p of uniquePreambles) console.log(`  · ${p.slice(0, 100)}…`);
    } else {
      console.log("No repeat on the wire. One prompt produced one pass of work.");
      console.log("If the panel showed it several times, the duplication is in the panel.");
    }
    if (logFile) console.log(`\nfull trace: ${logFile}`);
    verdict();
  };

  if (alsoClear && sessionId) {
    console.log("\nsending /clear …");
    send({ type: "command", sessionId, line: "/clear" });
    setTimeout(() => {
      report();
      shutdown();
    }, 2000);
    return;
  }
  report();
  shutdown();
}

function shutdown() {
  if (sessionId) send({ type: "shutdown", sessionId });
  setTimeout(() => {
    child.kill();
    process.exitCode = exitCode;
  }, 1500);
}

const timer = setTimeout(() => {
  console.log(`\nTIMED OUT after ${TURN_TIMEOUT_MS}ms — reporting what arrived so far.`);
  // A timeout is a FAILURE. Reporting what arrived is useful; exiting 0 afterwards
  // told anything scripting this harness that the turn had completed.
  timedOut = true;
  exitCode = 1;
  finish();
}, TURN_TIMEOUT_MS);
child.on("exit", (code) => {
  clearTimeout(timer);
  if (!finished) {
    // The engine went away before the turn ended. `finished ? 0 : code` reported
    // SUCCESS whenever a premature exit happened to be a clean one — which is the
    // shape of a well-behaved crash and the shape of `/exit`, so the two most likely
    // early exits were the two this could not see.
    console.log(`\nENGINE EXITED EARLY (code ${code ?? "null"}) — the turn never ended.`);
    process.exit(1);
  }
  process.exit(exitCode);
});

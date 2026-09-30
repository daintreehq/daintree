/**
 * Node-level benchmark for tail reads of the analysis mirror (terminal.getOutput,
 * terminal.getStatus, terminal.sendKeys, notify replies). Drives a real
 * AnalysisSession, so it times what the shared analysis worker actually runs.
 *
 *   npx tsx scripts/perf/bench-tail-serialize.ts [--runs 7] [--json]
 */
import { AnalysisSession } from "../../electron/services/pty/analysis/AnalysisSession.js";
import { readTailSnapshot, tailCapturedOutput } from "../../shared/utils/artifactParser.js";

const runsArg = Number(process.argv[process.argv.indexOf("--runs") + 1]);
const RUNS = Number.isInteger(runsArg) && runsArg > 0 ? runsArg : 7;
const LINES = 5050;
const TAIL = 40;

function coloredLine(i: number): string {
  const c = 31 + (i % 6);
  return `\x1b[${c}mline ${i}\x1b[0m \x1b[1;38;5;${(i * 7) % 255}mlorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ${i}\x1b[0m\r\n`;
}

async function main() {
  const session = new AnalysisSession(
    {
      terminalId: "bench",
      cols: 120,
      rows: 40,
      scrollback: 5000,
      restore: false,
      spawnedAt: Date.now(),
      epoch: 1,
    },
    () => {}
  );
  let chunk = "";
  for (let i = 0; i < LINES; i++) chunk += coloredLine(i);
  session.feedChunk(chunk, { agentLive: false });

  // The production helper: a build without tail reads ignores the hint and serializes everything.
  const readTail = async (): Promise<{ data: string }> => {
    const serialize = session.serialize as unknown as (o?: {
      tailRows: number;
    }) => Promise<{ data: string; partial?: true } | null>;
    const snap = await readTailSnapshot((options) => serialize.call(session, options), TAIL);
    if (!snap) throw new Error("serialize returned null");
    return snap;
  };

  await readTail(); // warm up JIT + drain
  const times: number[] = [];
  let bytes = 0;
  let last = "";
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    const snap = await readTail();
    const out = tailCapturedOutput(snap.data, TAIL, true);
    times.push(performance.now() - t0);
    bytes = snap.data.length;
    last = out.content;
    if (out.lineCount !== TAIL || !out.content.endsWith(`${LINES - 1}`)) {
      throw new Error("tail content does not match the expected last lines");
    }
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const result = {
    runs: RUNS,
    medianMs: +median.toFixed(3),
    minMs: +times[0].toFixed(3),
    payloadBytes: bytes,
    tailChars: last.length,
  };
  console.log(JSON.stringify(result));
  session.free();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

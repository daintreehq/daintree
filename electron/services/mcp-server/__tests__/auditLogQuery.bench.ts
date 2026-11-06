// Run: BENCH_OUT=/tmp/bytes.txt npx vitest bench --run electron/services/mcp-server/__tests__/auditLogQuery.bench.ts
//
// One recent-calls refresh of the help panel's activity strip, end to end
// minus the transport: main's read, the structured clone Electron IPC performs
// (v8 serializer), and the renderer's session filter. "full log" is the
// unqualified read the strip used to make; "narrow query" is the query it makes
// now.
import { writeFileSync } from "node:fs";
import { deserialize, serialize } from "node:v8";
import { test, describe } from "vitest";
import { AuditService, type McpAuditLogStore } from "../auditLog.js";
import type { McpAuditRecordQuery, McpLogRecord } from "../../../../shared/types/ipc/mcpServer.js";

const N = Number(process.env.BENCH_N ?? 10_000);
const LIMIT = 5;

// Oldest first, as the ring stores them. 40 help sessions round-robin, so the
// newest session's calls sit at the tail and a quiet session's only call sits
// near the head (the worst case for a newest-first scan).
const stored: McpLogRecord[] = [];
for (let i = 0; i < N; i++) {
  stored.push({
    id: `r${i}`,
    timestamp: 1_700_000_000_000 + i * 1000,
    toolId: `tool.${i % 30}`,
    sessionId: `transport-${i % 40}`,
    helpSessionId: i === 3 ? "help-quiet" : `help-${i % 40}`,
    tier: "external",
    argsSummary: `{"path":"/repo/src/file-${i}.ts","query":"needle ${i}"}`,
    result: i % 13 === 0 ? "error" : "success",
    durationMs: i % 97,
    turnId: `turn-${Math.floor(i / 8)}`,
  } as McpLogRecord);
}

const store: McpAuditLogStore = { read: () => stored, write: () => {} };
const service = new AuditService(
  () => {},
  () => ({ auditMaxRecords: N }),
  store
);
service.hydrate();

const bytes: Record<string, number> = {};

function refresh(label: string, sessionId: string, query?: McpAuditRecordQuery) {
  const payload = serialize(service.getRecords(query));
  bytes[label] = payload.byteLength;
  const all = deserialize(payload) as McpLogRecord[];
  const mine = all
    .filter((r) => "helpSessionId" in r && r.helpSessionId === sessionId)
    .slice(0, LIMIT);
  if (mine.length === 0) throw new Error("bench fixture produced no rows");
}

// Bench mode swallows console output, so sizes go to a file, outside the timing.
function report() {
  const out = process.env.BENCH_OUT;
  if (!out) return;
  writeFileSync(
    out,
    Object.entries(bytes)
      .map(([k, v]) => `${k}: ${v} bytes`)
      .join("\n") + "\n"
  );
}

const opts = { hooks: { afterAll: report }, run: { iterations: 30, warmupIterations: 3, time: 0 } };

describe(`activity strip refresh, ${N}-record log`, () => {
  const active = `help-${(N - 1) % 40}`;
  test("active session — full log", async ({ bench }) => {
    await bench("active session — full log", opts.hooks, () => refresh("active full", active)).run(
      opts.run
    );
  });
  test("active session — narrow query", async ({ bench }) => {
    await bench("active session — narrow query", opts.hooks, () =>
      refresh("active narrow", active, { helpSessionId: active, limit: LIMIT })
    ).run(opts.run);
  });
  test("quiet session — full log", async ({ bench }) => {
    await bench("quiet session — full log", opts.hooks, () =>
      refresh("quiet full", "help-quiet")
    ).run(opts.run);
  });
  test("quiet session — narrow query", async ({ bench }) => {
    await bench("quiet session — narrow query", opts.hooks, () =>
      refresh("quiet narrow", "help-quiet", { helpSessionId: "help-quiet", limit: LIMIT })
    ).run(opts.run);
  });
});

// @vitest-environment jsdom
// Run: BENCH_OUT=/tmp/rows.txt npx vitest bench --run src/components/Settings/__tests__/McpAuditLogViewer.bench.tsx
import { writeFileSync } from "node:fs";
import { bench, describe, vi } from "vitest";
import { act, cleanup, render, type RenderResult } from "@testing-library/react";
import type { McpLogRecord } from "@shared/types";

const counters = vi.hoisted(() => ({ timeRenders: 0 }));

// A controllable stand-in for the shared ticker, so a "minute tick" is one
// deterministic state bump instead of a 30s interval.
const ticker = vi.hoisted(() => {
  let tick = 0;
  const listeners = new Set<() => void>();
  return {
    bump() {
      tick++;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    get: () => tick,
  };
});

vi.mock("@/hooks/useGlobalMinuteTicker", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useGlobalMinuteTicker: () => useSyncExternalStore(ticker.subscribe, ticker.get),
  };
});

// Every row renders exactly one AuditRecordTime, so its render count is the
// number of rows React rendered.
vi.mock("../auditLogParts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auditLogParts")>();
  return {
    ...actual,
    AuditRecordTime: (props: { ts: number; now: number }) => {
      counters.timeRenders++;
      return actual.AuditRecordTime(props);
    },
  };
});

vi.mock("@/components/ui/select", () => import("@/components/ui/__tests__/nativeSelectMock"));

import { McpAuditLogViewer } from "../McpAuditLogViewer";

const N = Number(process.env.BENCH_N ?? 10_000);
const BASE = Date.UTC(2026, 0, 1);
vi.setSystemTime(BASE);

function makeRecords(n: number): McpLogRecord[] {
  const out: McpLogRecord[] = [];
  for (let i = 0; i < n; i++) {
    // Newest first, spread over ~3 days so labels span s/m/h/d buckets.
    const timestamp = BASE - i * 25_000;
    if (i % 20 === 19) {
      out.push({
        id: `g${i}`,
        type: "grant.used",
        timestamp,
        sessionId: `s${i % 7}`,
        toolId: "worktree.delete",
        maxUses: 3,
        remainingUses: 1,
      } as McpLogRecord);
    } else {
      out.push({
        id: `d${i}`,
        timestamp,
        toolId: `tool.${i % 40}`,
        sessionId: `s${i % 7}`,
        tier: "external",
        argsSummary: `{"path":"/repo/file-${i}.ts"}`,
        result: i % 11 === 0 ? "error" : "success",
        durationMs: i % 97,
      } as McpLogRecord);
    }
  }
  return out;
}

const records = makeRecords(N);
const noop = () => {};
const stats = { mountRows: [] as number[], tickRows: [] as number[] };

// Bench mode swallows console output, so row counts go to a file.
function report() {
  const out = process.env.BENCH_OUT;
  if (!out) return;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  writeFileSync(
    out,
    `rows rendered on mount: ${avg(stats.mountRows)}\nrows re-rendered per tick: ${avg(stats.tickRows)}\n`
  );
}

function mount(): RenderResult {
  return render(
    <McpAuditLogViewer
      records={records}
      loading={false}
      onRefresh={noop}
      onClear={noop}
      maxRecords={10_000}
    />
  );
}

describe(`McpAuditLogViewer, ${N} records`, () => {
  bench(
    "mount",
    () => {
      counters.timeRenders = 0;
      act(() => {
        mount();
      });
      stats.mountRows.push(counters.timeRenders);
      cleanup();
    },
    { iterations: 5, warmupIterations: 1, time: 0, teardown: report }
  );

  bench(
    "minute tick (mounted)",
    () => {
      counters.timeRenders = 0;
      act(() => {
        vi.setSystemTime(Date.now() + 60_000);
        ticker.bump();
      });
      stats.tickRows.push(counters.timeRenders);
    },
    {
      iterations: 10,
      warmupIterations: 1,
      time: 0,
      setup: () => {
        cleanup();
        vi.setSystemTime(BASE);
        act(() => {
          mount();
        });
      },
      teardown: () => {
        cleanup();
        report();
      },
    }
  );
});

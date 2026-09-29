// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpAnomalySignal, McpLogRecord } from "@shared/types";

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
  return { useGlobalMinuteTicker: () => useSyncExternalStore(ticker.subscribe, ticker.get) };
});
// Each row renders one AuditRecordTime, so this counts row renders.
const timeRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("../auditLogParts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auditLogParts")>();
  return {
    ...actual,
    AuditRecordTime: (props: { ts: number; now: number }) => {
      timeRenders.count++;
      return actual.AuditRecordTime(props);
    },
  };
});
vi.mock("@/components/ui/select", () => import("@/components/ui/__tests__/nativeSelectMock"));

import { McpAuditLogViewer } from "../McpAuditLogViewer";

const BASE = Date.UTC(2026, 0, 1);

function dispatch(id: string, toolId: string, ageMs: number): McpLogRecord {
  return {
    id,
    timestamp: BASE - ageMs,
    toolId,
    sessionId: "s",
    tier: "external",
    argsSummary: "{}",
    result: "success",
    durationMs: 3,
  } as McpLogRecord;
}

function advance(ms: number) {
  act(() => {
    vi.setSystemTime(Date.now() + ms);
    ticker.bump();
  });
}

function ageOf(toolId: string): string | null {
  const row = screen.getByText(toolId).closest("li");
  return row?.querySelector("time")?.textContent ?? null;
}

describe("McpAuditLogViewer on a minute tick", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves each row's age on, whether or not its label changes", () => {
    render(
      <McpAuditLogViewer
        records={[dispatch("1", "fresh.tool", 10_000), dispatch("2", "old.tool", 3 * 3_600_000)]}
        loading={false}
        onRefresh={vi.fn()}
      />
    );
    expect(ageOf("fresh.tool")).toBe("10s ago");
    expect(ageOf("old.tool")).toBe("3h ago");
    timeRenders.count = 0;
    advance(60_000);
    expect(ageOf("fresh.tool")).toBe("1m ago");
    expect(ageOf("old.tool")).toBe("3h ago");
    // Only the row whose label moved re-rendered.
    expect(timeRenders.count).toBe(1);
    advance(3_600_000);
    expect(ageOf("fresh.tool")).toBe("1h ago");
    expect(ageOf("old.tool")).toBe("4h ago");
  });

  it("clears a row's anomaly marker when its signal expires, though its age holds", () => {
    const signal = {
      kind: "burst",
      severity: "warning",
      recordIds: ["1"],
      expiresAt: BASE + 30_000,
    } as unknown as McpAnomalySignal;
    render(
      <McpAuditLogViewer
        records={[dispatch("1", "flagged.tool", 3 * 3_600_000)]}
        loading={false}
        onRefresh={vi.fn()}
        anomalySignals={[signal]}
        anomalySuppressed={false}
      />
    );
    const row = () => screen.getByText("flagged.tool").closest("li")!;
    expect(row().querySelector('[aria-label="Anomaly (warning)"]')).not.toBeNull();
    advance(60_000);
    expect(ageOf("flagged.tool")).toBe("3h ago");
    expect(row().querySelector('[aria-label="Anomaly (warning)"]')).toBeNull();
  });

  it("drops a record that ages out of a bounded time range", () => {
    render(
      <McpAuditLogViewer
        records={[dispatch("1", "recent.tool", 60_000), dispatch("2", "edge.tool", 4 * 60_000)]}
        loading={false}
        onRefresh={vi.fn()}
      />
    );
    fireEvent.change(screen.getByLabelText("Filter audit by time range"), {
      target: { value: "5m" },
    });
    expect(screen.getByText("edge.tool")).toBeTruthy();
    advance(2 * 60_000);
    expect(screen.queryByText("edge.tool")).toBeNull();
    expect(screen.getByText("recent.tool")).toBeTruthy();
  });
});

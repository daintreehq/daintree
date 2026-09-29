// @vitest-environment jsdom
import { Profiler } from "react";
import { appendFileSync } from "fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { TerminalHeaderContent } from "../TerminalHeaderContent";
import { CPU_HISTORY_SIZE, useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import type { TerminalResourceBatchPayload } from "@shared/types/pty-host";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../TerminalNotifyChip", () => ({ TerminalNotifyChip: () => null }));
vi.mock("../SubagentChip", () => ({ SubagentChip: () => null }));
vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ panelsById: {}, panelIds: [] }),
}));

const HEADERS = 20;
const ids = Array.from({ length: HEADERS }, (_, i) => `t${i}`);

function batch(overrides: Record<string, number> = {}): TerminalResourceBatchPayload {
  const out: TerminalResourceBatchPayload = {};
  for (const id of ids) {
    out[id] = {
      cpuPercent: overrides[id] ?? 2,
      memoryKb: 40960,
      processCount: 2,
      breakdown: [{ pid: 10, comm: "zsh", cpuPercent: 2, memoryKb: 40960 }],
    };
  }
  return out;
}

beforeEach(() => {
  useResourceMonitoringStore.setState({ enabled: true, metrics: new Map() });
});

afterEach(() => {
  useResourceMonitoringStore.setState({ enabled: false, metrics: new Map() });
});

describe("TerminalHeaderContent — resource poll renders", () => {
  function mountSettled(renders: Map<string, number>) {
    for (let i = 0; i < CPU_HISTORY_SIZE; i++) {
      useResourceMonitoringStore.getState().updateMetrics(batch());
    }
    render(
      <>
        {ids.map((id) => (
          <Profiler key={id} id={id} onRender={() => renders.set(id, (renders.get(id) ?? 0) + 1)}>
            <TerminalHeaderContent id={id} kind="terminal" />
          </Profiler>
        ))}
      </>
    );
    // Count only what the polls cause, not the mount.
    renders.clear();
  }

  it("does not re-render a header for a poll that changes nothing it shows", () => {
    const renders = new Map<string, number>();
    mountSettled(renders);

    const TICKS = 10;
    for (let i = 0; i < TICKS; i++) {
      act(() => useResourceMonitoringStore.getState().updateMetrics(batch()));
    }

    const total = [...renders.values()].reduce((a, b) => a + b, 0);
    if (process.env.BENCH_OUT) {
      appendFileSync(
        process.env.BENCH_OUT,
        `header renders over ${TICKS} identical polls x ${HEADERS}=${total}\n`
      );
    }
    expect(total).toBe(0);
  });

  it("shows the band of a sample that settled before the header mounted", () => {
    for (let i = 0; i < CPU_HISTORY_SIZE + 5; i++) {
      useResourceMonitoringStore.getState().updateMetrics(batch({ t0: 90 }));
    }

    const { container } = render(<TerminalHeaderContent id="t0" kind="terminal" />);

    const badge = container.querySelector('[data-testid="terminal-resource-badge"]');
    expect(badge!.getAttribute("data-severity")).toBe("red");
  });

  it("re-renders only the header whose sample moved", () => {
    const renders = new Map<string, number>();
    mountSettled(renders);

    act(() => useResourceMonitoringStore.getState().updateMetrics(batch({ t3: 40 })));

    expect([...renders.keys()]).toEqual(["t3"]);
  });
});

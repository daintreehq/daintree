// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import path from "path";
import type { ComponentType } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  importCompiled,
  isComponent,
  removeCompiledModules,
} from "@/components/Worktree/__tests__/compileWithReactCompiler";

vi.mock("@/components/Fleet/crossHostFleet", () => ({
  armCrossHostTarget: vi.fn(),
  crossHostTargetKey: (hostId: string, terminalId: string) => `${hostId}:${terminalId}`,
  disarmCrossHostTarget: vi.fn(),
  useArmedCrossHostTargets: () => [],
}));

// Compiled as in the app, so a label that reads the clock during render freezes here too.
vi.mock("@/components/ui/TimeAgo", async () => {
  const { importCompiled: compile } =
    await import("@/components/Worktree/__tests__/compileWithReactCompiler");
  const { resolve } = await import("path");
  return compile(resolve(__dirname, "../../../ui/TimeAgo.tsx"));
});
vi.mock("@/hooks/useGlobalMinuteTicker", async () => {
  const { importCompiled: compile } =
    await import("@/components/Worktree/__tests__/compileWithReactCompiler");
  const { resolve } = await import("path");
  return compile(resolve(__dirname, "../../../../hooks/useGlobalMinuteTicker.ts"));
});

type Props = { hostId: string; hostName: string };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
afterAll(() => removeCompiledModules());

function advance(totalMs: number) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += 30_000) {
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
  }
}

describe("HostFleetTargets observed label (compiled)", () => {
  it("ages while the section stays open, and a refresh returns it to just now", async () => {
    const value = (await importCompiled(path.resolve(__dirname, "../HostFleetTargets.tsx")))
      .HostFleetTargets;
    if (!isComponent<Props>(value)) throw new Error("not a component");
    const HostFleetTargets: ComponentType<Props> = value;

    vi.useFakeTimers();
    Object.defineProperty(window, "electron", {
      value: {
        hostMetrics: {
          listFleetTargets: vi.fn(async () => ({
            targets: [
              {
                hostId: "h",
                terminalId: "t1",
                title: "one",
                projectId: "p",
                projectName: "app",
                agentId: "claude",
                agentState: "idle",
              },
            ],
            complete: true,
          })),
        },
      },
      configurable: true,
      writable: true,
    });
    render(<HostFleetTargets hostId="h" hostName="h" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add agents on h to the fleet" }));
    });
    await act(async () => {});

    const label = () => document.querySelector("time")?.textContent;
    const first = label();
    expect(first).toMatch(/^Observed /);

    advance(3 * 60_000);
    expect(label()).not.toBe(first);
    expect(label()).toMatch(/^Observed \d+m ago$/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    });
    await act(async () => {});
    expect(label()).toBe(first);
  });
});

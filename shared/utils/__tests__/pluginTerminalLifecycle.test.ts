import { describe, it, expect } from "vitest";
import {
  toPluginTerminalLifecycleEvent,
  type TerminalLifecycleObservation,
} from "../pluginTerminalLifecycle.js";

const base: TerminalLifecycleObservation = {
  type: "spawned",
  terminalId: "term-1",
  projectId: "project-1",
  worktreeId: "wt-1",
  kind: "agent",
  agentId: "claude",
  timestamp: 5,
};

describe("toPluginTerminalLifecycleEvent", () => {
  it("projects a spawn with the host-resolved workspace and freezes it", () => {
    const event = toPluginTerminalLifecycleEvent(base, { workspaceId: "project-1" });
    expect(event).toEqual({
      type: "spawned",
      terminalId: "term-1",
      workspaceId: "project-1",
      worktreeId: "wt-1",
      kind: "agent",
      agentId: "claude",
      timestamp: 5,
    });
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("never lets a command, cwd, title, env or output field through", () => {
    const planted = "SECRET-planted-value";
    const event = toPluginTerminalLifecycleEvent(
      {
        ...base,
        type: "exited",
        exitCode: 1,
        signal: 9,
        command: `claude --token ${planted}`,
        cwd: `/Users/someone/${planted}`,
        title: planted,
        env: { API_KEY: planted },
        recentOutput: planted,
        args: [planted],
        launchGeneration: 3,
        projectPath: planted,
      },
      { workspaceId: "project-1" }
    );
    expect(event).not.toBeNull();
    expect(Object.keys(event!).sort()).toEqual([
      "agentId",
      "exitCode",
      "kind",
      "signal",
      "terminalId",
      "timestamp",
      "type",
      "workspaceId",
      "worktreeId",
    ]);
    expect(JSON.stringify(event)).not.toContain(planted);
  });

  it("takes the workspace from the context, never a payload-supplied one", () => {
    const spoofed = { ...base, workspaceId: "spoofed" };
    expect(toPluginTerminalLifecycleEvent(spoofed, { workspaceId: "project-1" })?.workspaceId).toBe(
      "project-1"
    );
    expect("workspaceId" in toPluginTerminalLifecycleEvent(spoofed, { workspaceId: null })!).toBe(
      false
    );
  });

  it("re-projects a structured-cloned plugin event from its own workspace id", () => {
    const first = toPluginTerminalLifecycleEvent(base, { workspaceId: "project-1" });
    const cloned = structuredClone(first) as unknown;
    const rebuilt = toPluginTerminalLifecycleEvent(cloned);
    expect(rebuilt).toEqual(first);
    expect(Object.isFrozen(rebuilt)).toBe(true);
  });

  it("omits optional fields that are missing, empty or not strings", () => {
    const event = toPluginTerminalLifecycleEvent(
      { ...base, kind: "shell", agentId: "", worktreeId: 7 as unknown as string },
      { workspaceId: "" }
    );
    expect(event).toEqual({ type: "spawned", terminalId: "term-1", kind: "shell", timestamp: 5 });
  });

  it("keeps a real signal and drops the zero Windows reports", () => {
    const exited = { ...base, type: "exited" as const, exitCode: 0 };
    expect(toPluginTerminalLifecycleEvent({ ...exited, signal: 15 }, {})).toMatchObject({
      exitCode: 0,
      signal: 15,
    });
    for (const signal of [0, undefined, -1, Number.NaN]) {
      const event = toPluginTerminalLifecycleEvent({ ...exited, signal }, {});
      expect(event).not.toBeNull();
      expect("signal" in event!).toBe(false);
    }
  });

  it("carries the observation time on a rate-limit event", () => {
    expect(
      toPluginTerminalLifecycleEvent({ ...base, type: "rate-limit-observed", observedAt: 4 }, {})
    ).toMatchObject({ type: "rate-limit-observed", observedAt: 4 });
  });

  it("does not carry variant fields onto the variants that do not own them", () => {
    for (const type of ["spawned", "trashed", "restored"] as const) {
      const event = toPluginTerminalLifecycleEvent(
        { ...base, type, exitCode: 1, signal: 9, observedAt: 4 },
        {}
      );
      expect(event?.type).toBe(type);
      expect("exitCode" in event!).toBe(false);
      expect("signal" in event!).toBe(false);
      expect("observedAt" in event!).toBe(false);
    }
  });

  it("rejects values that are not well-formed events", () => {
    const malformed: unknown[] = [
      null,
      "spawned",
      { ...base, type: "killed" },
      { ...base, terminalId: "" },
      { ...base, kind: "dev-preview" },
      { ...base, timestamp: "5" },
      { ...base, type: "exited" },
      { ...base, type: "exited", exitCode: Number.POSITIVE_INFINITY },
      { ...base, type: "rate-limit-observed" },
    ];
    for (const value of malformed) {
      expect(toPluginTerminalLifecycleEvent(value, {})).toBeNull();
    }
  });
});

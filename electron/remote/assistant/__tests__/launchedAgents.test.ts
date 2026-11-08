import { describe, expect, it } from "vitest";
import {
  LAUNCHED_AGENT_LISTING_GRACE_MS,
  LaunchedAgents,
  launchedTerminalIds,
  launchesAgents,
} from "../launchedAgents.js";

describe("launchedTerminalIds (#16492)", () => {
  it("names a launch's own terminal, and a launch in a new worktree's", () => {
    expect(launchedTerminalIds({ launched: true, terminalId: "t-1", location: "grid" })).toEqual([
      "t-1",
    ]);
    expect(
      launchedTerminalIds({
        launched: true,
        terminalId: "t-2",
        creation: { worktreeId: "w" },
        setup: { setupState: "ready" },
      })
    ).toEqual(["t-2"]);
  });

  it("names none for a launch that declined, an error, or anything unreadable", () => {
    expect(launchedTerminalIds({ launched: false, terminalId: "t-1" })).toEqual([]);
    expect(launchedTerminalIds({ code: "LAUNCH_DECLINED", message: "no" })).toEqual([]);
    expect(launchedTerminalIds({ terminalId: "" })).toEqual([]);
    expect(launchedTerminalIds(null)).toEqual([]);
    expect(launchedTerminalIds(["t-1"])).toEqual([]);
    expect(launchedTerminalIds({ results: "t-1" })).toEqual([]);
  });

  it("names each batch item that ran, once", () => {
    expect(
      launchedTerminalIds({
        results: [
          { target: "a", ok: true, result: { terminalId: "t-1" } },
          { target: "b", ok: false, result: { terminalId: "t-2" } },
          { target: "c", ok: true, result: { launched: false, terminalId: "t-3" } },
          { target: "d", ok: true, result: { terminalId: "t-1" } },
          null,
        ],
      })
    ).toEqual(["t-1"]);
  });

  it("follows the tools that launch agents only", () => {
    expect(launchesAgents("agent.launch")).toBe(true);
    expect(launchesAgents("agent.launchMany")).toBe(true);
    expect(launchesAgents("agent.launchInNewWorktree")).toBe(true);
    expect(launchesAgents("workflow.startWorkOnIssue")).toBe(true);
    expect(launchesAgents("terminal.sendCommand")).toBe(false);
  });
});

describe("LaunchedAgents (#16492)", () => {
  it("keeps a resend's answer to the first send's bound", () => {
    let mono = 0;
    const agents = new LaunchedAgents(() => mono, 1_000);
    agents.launching("studio", "c1");
    mono = 600;
    agents.launching("studio", "c1");
    agents.launched("studio", "c1", ["t-1"]);
    mono = 999;
    expect(agents.holds("studio")).toBe(true);
    mono = 1_000;
    expect(agents.holds("studio")).toBe(false);
  });

  it("never lets a call's answer for another host take over its launch", () => {
    const agents = new LaunchedAgents(() => 0, 1_000);
    agents.launching("studio", "c1");
    agents.launched("other", "c1", ["t-1"]);
    expect(agents.holds("other")).toBe(false);
    expect(agents.holds("studio")).toBe(true);
  });

  it("lets go of only the listed host's missing agents named before the list's grace", () => {
    let mono = 0;
    const agents = new LaunchedAgents(() => mono, 100_000);
    agents.launched("studio", "c1", ["t-1", "t-2"]);
    agents.launched("other", "c2", ["t-1"]);
    mono = 10_000;
    agents.launched("studio", "c3", ["t-3"]);
    agents.listed("studio", new Set(["t-2"]), LAUNCHED_AGENT_LISTING_GRACE_MS);
    // t-1 ended there; t-3 was named too late to have shown; the other host is untouched.
    agents.listed("studio", new Set(), LAUNCHED_AGENT_LISTING_GRACE_MS);
    expect(agents.holds("studio")).toBe(true);
    agents.listed("studio", new Set(), LAUNCHED_AGENT_LISTING_GRACE_MS + 10_000);
    expect(agents.holds("studio")).toBe(false);
    expect(agents.holds("other")).toBe(true);
    agents.forgetHost("other");
    expect(agents.holds("other")).toBe(false);
  });

  it("lets the oldest go past its cap rather than growing", () => {
    const agents = new LaunchedAgents(() => 0, 1_000);
    agents.launched("first", "c0", ["t-0"]);
    for (let i = 1; i <= 512; i++) agents.launched("studio", `c${i}`, [`t-${i}`]);
    expect(agents.holds("first")).toBe(false);
    expect(agents.holds("studio")).toBe(true);
  });
});

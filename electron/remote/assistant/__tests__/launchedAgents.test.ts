import { describe, expect, it } from "vitest";
import {
  LAUNCHED_AGENT_UNLISTED_MS,
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
          { target: "d", ok: true, result: { terminalId: "t-4" } },
          { target: "e", ok: true, result: { terminalId: "t-1" } },
          null,
        ],
      })
    ).toEqual(["t-1", "t-4"]);
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
    agents.launching("studio", "a", "c1");
    mono = 600;
    agents.launching("studio", "a", "c1");
    agents.launched("studio", "c1", ["t-1"]);
    mono = 999;
    expect(agents.holds("studio")).toBe(true);
    mono = 1_000;
    expect(agents.holds("studio")).toBe(false);
  });

  it("keeps a launch to its own host and session", () => {
    const agents = new LaunchedAgents(() => 0, 1_000);
    agents.launching("studio", "a", "c1");
    expect(agents.launchOf("c1")).toEqual({ hostId: "studio", helpSessionId: "a" });
    agents.launched("other", "c1", ["t-1"]);
    agents.launchFailed("other", "c1");
    expect(agents.holds("other")).toBe(false);
    expect(agents.holds("studio")).toBe(true);
    agents.launchFailed("studio", "c1");
    expect(agents.holds("studio")).toBe(false);
    expect(agents.launchOf("c1")).toBeNull();
  });

  it("lets go of a listed agent on the first full list without it, an unlisted one only once it had time to start", () => {
    let mono = 0;
    const agents = new LaunchedAgents(() => mono, 10 * LAUNCHED_AGENT_UNLISTED_MS);
    agents.launched("studio", "c1", ["t-1", "t-2"]);
    agents.launched("other", "c2", ["t-1"]);
    agents.listed("studio", new Set(["t-1"]), 0);
    mono = 1_000;
    agents.listed("studio", new Set(), 1_000);
    // t-1 was listed, so it ended; t-2 may still be starting.
    expect(agents.holds("studio")).toBe(true);
    agents.listed("studio", new Set(), LAUNCHED_AGENT_UNLISTED_MS - 1);
    expect(agents.holds("studio")).toBe(true);
    agents.listed("studio", new Set(), LAUNCHED_AGENT_UNLISTED_MS);
    expect(agents.holds("studio")).toBe(false);
    // Ended ones stay ended when an answer names them again; the other host is untouched.
    agents.launched("studio", "c1", ["t-1", "t-2"]);
    expect(agents.holds("studio")).toBe(false);
    expect(agents.holds("other")).toBe(true);
    agents.forgetHost("other");
    expect(agents.holds("other")).toBe(false);
  });

  it("lets the oldest go past each cap rather than growing", () => {
    const agents = new LaunchedAgents(() => 0, 1_000);
    agents.launched("first", "c0", ["t-0"]);
    agents.launched("second", "c1", ["t-1"]);
    for (let i = 2; i <= 512; i++) agents.launched("rest", `c${i}`, [`t-${i}`]);
    expect(agents.holds("first")).toBe(false);
    expect(agents.holds("second")).toBe(true);

    const launches = new LaunchedAgents(() => 0, 1_000);
    launches.launching("first", "a", "l0");
    launches.launching("second", "a", "l1");
    for (let i = 2; i <= 512; i++) launches.launching("rest", "a", `l${i}`);
    expect(launches.holds("first")).toBe(false);
    expect(launches.holds("second")).toBe(true);

    // The oldest ended agent past its cap may be named again; a later one may not.
    const ended = new LaunchedAgents(() => 0, 1_000);
    const ids = Array.from({ length: 1025 }, (_, i) => `t-${i}`);
    for (let i = 0; i < ids.length; i += 500) {
      ended.launched("studio", `c${i}`, ids.slice(i, i + 500));
      ended.listed("studio", new Set(), LAUNCHED_AGENT_UNLISTED_MS);
    }
    ended.launched("studio", "again", ["t-0"]);
    expect(ended.holds("studio")).toBe(true);
    ended.forgetHost("studio");
    ended.launched("studio", "again", ["t-1"]);
    expect(ended.holds("studio")).toBe(false);
  });
});

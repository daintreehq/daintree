import { describe, expect, it } from "vitest";
import {
  CHANNEL_LEASE_POLICY,
  CHANNEL_LEASE_TARGETS,
  getChannelLeasePolicy,
  getChannelLeaseTarget,
  requiresDriveLease,
} from "../channelLeasePolicy.js";
import { CHANNEL_LOCALITY, getChannelLocality } from "../channelLocality.js";

describe("channel lease policy", () => {
  it("classifies every host and hybrid channel, and nothing the Shell answers", () => {
    const hostSide = Object.entries(CHANNEL_LOCALITY)
      .filter(([, locality]) => locality !== "shell")
      .map(([channel]) => channel)
      .sort();
    expect(Object.keys(CHANNEL_LEASE_POLICY).sort()).toEqual(hostSide);
  });

  it("never gates taking the lease, reading it, or asking what became of an operation", () => {
    for (const channel of [
      "drive-lease:take-over",
      "drive-lease:get",
      "operations:get-status",
      "operations:list",
      "worktree:get-all",
      "terminal:get-for-project",
      "terminal:reconnect-bulk",
      "app:hydrate",
      "review-marks:hydrate",
      "review-marks:capture",
      "review-marks:compare",
      "review-marks:file-since",
    ]) {
      expect(getChannelLeasePolicy(channel), channel).toBe("free");
    }
  });

  it("gates the project mutations a displaced frontend could otherwise still make", () => {
    for (const channel of [
      "worktree:create",
      "worktree:delete",
      "git:commit",
      "git:push",
      "terminal:spawn",
      "terminal:kill",
      "project:set-terminals",
      "project:set-tab-groups",
      "project:set-draft-inputs",
      "app:set-state",
      "plugin-agent-mcp:set-plugin-access",
      "review-marks:mark",
      "review-marks:mark-captured",
      "review-marks:clear",
    ]) {
      expect(getChannelLeasePolicy(channel), channel).toBe("driver");
    }
  });

  it("leaves terminal input to its handler, which gates it per terminal", () => {
    for (const channel of ["terminal:input", "terminal:submit", "terminal:resize"]) {
      expect(getChannelLeasePolicy(channel), channel).toBe("handler");
      expect(requiresDriveLease(channel, "link")).toBe(false);
    }
  });

  it("holds a local view to the lease only on host channels", () => {
    expect(getChannelLocality("app:set-state")).toBe("hybrid");
    expect(requiresDriveLease("app:set-state", "link")).toBe(true);
    expect(requiresDriveLease("app:set-state", "local")).toBe(false);
    expect(requiresDriveLease("worktree:create", "local")).toBe(true);
  });

  it("treats a channel it doesn't name as free", () => {
    expect(getChannelLeasePolicy("window:new")).toBe("free");
    expect(getChannelLeasePolicy("plugin:acme:push")).toBe("free");
    expect(getChannelLeasePolicy("not-a:channel")).toBe("free");
  });

  it("names how every driver channel's target project is found, and only for driver channels", () => {
    const drivers = Object.entries(CHANNEL_LEASE_POLICY)
      .filter(([, policy]) => policy === "driver")
      .map(([channel]) => channel)
      .sort();
    expect(Object.keys(CHANNEL_LEASE_TARGETS).sort()).toEqual(drivers);
    for (const channel of drivers) {
      const target = getChannelLeaseTarget(channel);
      expect(target, channel).not.toBeNull();
      expect(target!.length, channel).toBeGreaterThan(0);
    }
    expect(getChannelLeaseTarget("worktree:get-all")).toBeNull();
  });

  it("traces a mutation that names another project's repository or terminal to that project", () => {
    expect(getChannelLeaseTarget("worktree:create")).toEqual([
      { from: "path", at: [0, "rootPath"] },
    ]);
    expect(getChannelLeaseTarget("git:commit")).toEqual([{ from: "path", at: [0, "cwd"] }]);
    expect(getChannelLeaseTarget("terminal:restore")).toEqual([{ from: "terminal", at: [0] }]);
    expect(getChannelLeaseTarget("worktree:delete")).toEqual([
      { from: "worktree", at: [0, "worktreeId"] },
    ]);
  });

  it("lets only a call that ends a terminal pass for one this Host no longer has", () => {
    for (const channel of ["terminal:kill", "terminal:graceful-kill", "terminal:trash"]) {
      expect(getChannelLeaseTarget(channel), channel).toEqual([
        { from: "terminal", at: [0], missing: "allow" },
      ]);
    }
    for (const channel of [
      "terminal:restore",
      "terminal:update-title",
      "terminal:update-worktree-id",
      "agent-session:prepare-bookmark",
    ]) {
      const target = getChannelLeaseTarget(channel)!;
      expect(
        target.some((source) => "missing" in source),
        channel
      ).toBe(false);
    }
  });

  it("gates bookmarking a live agent, which kills it to capture its session", () => {
    expect(getChannelLeasePolicy("agent-session:prepare-bookmark")).toBe("driver");
    expect(getChannelLeaseTarget("agent-session:prepare-bookmark")).toEqual([
      { from: "terminal", at: [0, "terminalId"] },
    ]);
  });

  it("gates clearing and pruning session history, which every project resumes from, but not reading it", () => {
    expect(requiresDriveLease("agent-session:clear", "local")).toBe(true);
    expect(requiresDriveLease("agent-session:set-retention", "local")).toBe(true);
    expect(requiresDriveLease("agent-session:list", "link")).toBe(false);
    expect(requiresDriveLease("agent-session:get-retention", "link")).toBe(false);
  });

  it("leaves a plugin call's writes to the host APIs it reaches, since the same call carries its reads", () => {
    expect(getChannelLeasePolicy("plugin:invoke")).toBe("handler");
    expect(requiresDriveLease("plugin:invoke", "link")).toBe(false);
  });

  it("keeps navigation free: switching and reopening hold their outgoing save to the lease themselves", () => {
    expect(getChannelLeasePolicy("project:switch")).toBe("free");
    expect(getChannelLeasePolicy("project:reopen")).toBe("free");
  });

  it("treats worktree:remove, a push to the view, as the event it is", () => {
    expect(getChannelLeasePolicy("worktree:remove")).toBe("free");
  });
});

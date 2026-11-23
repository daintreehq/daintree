import { describe, expect, it } from "vitest";
import { HostCallArgsSchema } from "../hostControl.js";
import { makeInstalledProjectInstanceKey } from "../plugin/instanceKeys.js";

// #18153: a project plugin's action id carries its 64-character project id, so
// this machine's own projects take longer tool ids than a host's link carries.
describe("HostCallArgsSchema tool ids", () => {
  const projectId = "a".repeat(64);
  const pluginActionId = `${makeInstalledProjectInstanceKey(projectId, "acme-tools.release-stages")}.resume-paused-stage`;

  it("takes a project plugin's action id on this machine", () => {
    expect(pluginActionId.length).toBeGreaterThan(128);
    const parsed = HostCallArgsSchema.safeParse({
      hostId: "local",
      projectId,
      tool: pluginActionId,
    });
    expect(parsed.success).toBe(true);
  });

  it("holds a host to the ids its link carries", () => {
    const parsed = HostCallArgsSchema.safeParse({
      hostId: "studio",
      projectId,
      tool: pluginActionId,
    });
    expect(parsed.success).toBe(false);
    expect(
      HostCallArgsSchema.safeParse({ hostId: "studio", projectId, tool: "x".repeat(128) }).success
    ).toBe(true);
  });

  it("draws each limit at its own boundary", () => {
    const parses = (hostId: string, length: number) =>
      HostCallArgsSchema.safeParse({ hostId, projectId, tool: "x".repeat(length) }).success;
    expect([parses("local", 256), parses("local", 257)]).toEqual([true, false]);
    expect([parses("studio", 128), parses("studio", 129)]).toEqual([true, false]);
  });
});

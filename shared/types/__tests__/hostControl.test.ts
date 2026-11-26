import { describe, expect, it } from "vitest";
import { HostCallArgsSchema } from "../hostControl.js";
import { makeInstalledProjectInstanceKey } from "../plugin/instanceKeys.js";

// #18153: a project plugin's action id carries its 64-character project id, so
// a project takes longer tool ids than any built-in needs, on any host (#18255).
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

  it("takes it for another machine's project too (#18255)", () => {
    const parsed = HostCallArgsSchema.safeParse({
      hostId: "studio",
      projectId,
      tool: pluginActionId,
    });
    expect(parsed.success).toBe(true);
  });

  it("draws one limit for every host", () => {
    const parses = (hostId: string, length: number) =>
      HostCallArgsSchema.safeParse({ hostId, projectId, tool: "x".repeat(length) }).success;
    expect([parses("local", 256), parses("local", 257)]).toEqual([true, false]);
    expect([parses("studio", 256), parses("studio", 257)]).toEqual([true, false]);
    expect([parses("local", 0), parses("studio", 0)]).toEqual([false, false]);
  });
});

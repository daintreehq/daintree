import { describe, expect, it } from "vitest";
import { isRemoteContributionActionAllowed } from "../remotePluginContributions.js";

describe("isRemoteContributionActionAllowed", () => {
  it("refuses actions closed to plugin dispatch, even when a host sends them anyway", () => {
    expect(isRemoteContributionActionAllowed("acme.graph", "terminal.paste")).toBe(false);
    expect(isRemoteContributionActionAllowed("acme.graph", "terminal.sendCommand")).toBe(false);
  });

  it("lets built-in actions and the plugin's own namespace through", () => {
    expect(isRemoteContributionActionAllowed("acme.graph", "terminal.new")).toBe(true);
    expect(isRemoteContributionActionAllowed("acme.graph", "acme.graph.open")).toBe(true);
    // A project plugin's actions carry its whole instance id, project included.
    const project = `project__${"a".repeat(8)}__acme.graph`;
    expect(isRemoteContributionActionAllowed(project, `${project}.open`)).toBe(true);
    expect(isRemoteContributionActionAllowed(project, "acme.graph.open")).toBe(false);
  });

  it("refuses another plugin's namespace or an action that doesn't exist", () => {
    expect(isRemoteContributionActionAllowed("acme.graph", "other.plugin.run")).toBe(false);
    expect(isRemoteContributionActionAllowed("acme.graph", "acme.graphx.run")).toBe(false);
    expect(isRemoteContributionActionAllowed("acme.graph", "nonsense")).toBe(false);
  });
});

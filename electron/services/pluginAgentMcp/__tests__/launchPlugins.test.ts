import { describe, expect, it } from "vitest";
import { classifyRequiredPluginTools, type LaunchPluginsReport } from "../launchPlugins.js";
import type { DeclaredAgentMcpPlugin } from "../types.js";

function declared(pluginInstanceId: string, pluginDisplayName = ""): DeclaredAgentMcpPlugin {
  return {
    pluginInstanceId,
    pluginManifestId: pluginInstanceId,
    pluginDisplayName,
    origin: "global",
    hasDatabases: true,
  };
}

function report(overrides: Partial<LaunchPluginsReport> = {}): LaunchPluginsReport {
  return { plugins: [], declared: [], pending: false, ...overrides };
}

const SCOPE = { databases: true };

describe("classifyRequiredPluginTools", () => {
  it("reads a plugin the launch would hand over as ready", () => {
    const plugin = declared("acme.ledger", "Ledger");
    const states = classifyRequiredPluginTools(
      report({
        plugins: [{ plugin, record: {} as never, scope: SCOPE, serverKey: "daintree-ledger" }],
        declared: [{ plugin, scope: SCOPE }],
      }),
      ["acme.ledger"]
    );
    expect(states).toEqual([
      { pluginInstanceId: "acme.ledger", pluginDisplayName: "Ledger", state: "ready" },
    ]);
  });

  it("tells access that is off apart from a plugin still loading or not running", () => {
    const off = declared("acme.off", "Off plugin");
    const states = classifyRequiredPluginTools(
      report({ declared: [{ plugin: off, scope: null }], pending: true }),
      ["acme.off", "acme.loading"]
    );
    expect(states.map((s) => s.state)).toEqual(["disabled-access", "pending-load"]);

    const settled = classifyRequiredPluginTools(report(), ["acme.gone"]);
    expect(settled.map((s) => s.state)).toEqual(["unavailable"]);
  });

  it("reads every required plugin as disabled-access when nothing has access in the project", () => {
    const states = classifyRequiredPluginTools(report({ noAccess: true }), ["acme.ledger"]);
    expect(states.map((s) => s.state)).toEqual(["disabled-access"]);
  });

  it("names a plugin it can't find by its manifest id, and lists each one once", () => {
    const states = classifyRequiredPluginTools(report(), ["acme.ledger", "acme.ledger"]);
    expect(states).toEqual([
      { pluginInstanceId: "acme.ledger", pluginDisplayName: "acme.ledger", state: "unavailable" },
    ]);
  });
});

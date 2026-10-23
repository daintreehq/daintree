import { afterEach, describe, expect, it } from "vitest";
import {
  clearPluginToolsLaunches,
  forgetPluginToolsLaunch,
  listRelaunchNeeded,
  recordPluginToolsLaunch,
  type EligiblePluginTools,
} from "../agentLaunchRecords.js";
import type { PluginMcpGrant } from "../grantRegistry.js";
import type { AgentMcpToolScope } from "../types.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);

const READ_WRITE: AgentMcpToolScope = { databases: true, pluginEndpointId: "data" };
const READ_ONLY: AgentMcpToolScope = { databases: true };

function grant(terminalId: string, pluginInstanceId: string, scope: AgentMcpToolScope) {
  return { terminalId, pluginInstanceId, scope } as unknown as PluginMcpGrant;
}

function eligible(pluginInstanceId: string, scope: AgentMcpToolScope): EligiblePluginTools {
  return { pluginInstanceId, pluginDisplayName: pluginInstanceId.toUpperCase(), scope };
}

describe("listRelaunchNeeded", () => {
  afterEach(() => clearPluginToolsLaunches());

  it("lists an agent that started before a plugin it would now get was turned on", () => {
    recordPluginToolsLaunch("t1", PROJECT_A);
    expect(listRelaunchNeeded(PROJECT_A, [eligible("ledger", READ_WRITE)], () => [])).toEqual([
      { terminalId: "t1", pluginDisplayNames: ["LEDGER"] },
    ]);
  });

  it("doesn't list an agent whose live grants match, as after a reload that kept them", () => {
    recordPluginToolsLaunch("t1", PROJECT_A);
    const grants = [grant("t1", "ledger", READ_WRITE)];
    expect(listRelaunchNeeded(PROJECT_A, [eligible("ledger", READ_WRITE)], () => grants)).toEqual(
      []
    );
  });

  it("lists an agent whose grant reaches different tools than a launch would now get", () => {
    recordPluginToolsLaunch("t1", PROJECT_A);
    const grants = [grant("t1", "ledger", READ_ONLY)];
    expect(
      listRelaunchNeeded(PROJECT_A, [eligible("ledger", READ_WRITE)], () => grants)
    ).toHaveLength(1);
  });

  it("doesn't list an agent for access that was taken away, which a relaunch wouldn't restore", () => {
    recordPluginToolsLaunch("t1", PROJECT_A);
    expect(listRelaunchNeeded(PROJECT_A, [], () => [grant("t1", "ledger", READ_WRITE)])).toEqual(
      []
    );
  });

  it("keeps projects apart and forgets an agent once it exits", () => {
    recordPluginToolsLaunch("t1", PROJECT_A);
    recordPluginToolsLaunch("t2", PROJECT_B);
    const now = [eligible("ledger", READ_WRITE)];
    expect(listRelaunchNeeded(PROJECT_B, now, () => []).map((s) => s.terminalId)).toEqual(["t2"]);

    forgetPluginToolsLaunch("t2");
    expect(listRelaunchNeeded(PROJECT_B, now, () => [])).toEqual([]);
    expect(listRelaunchNeeded(PROJECT_A, now, () => [])).toHaveLength(1);
  });

  it("lists an agent whose groups differ, and not one whose groups only come in another order", () => {
    const search = { id: "search", access: "read" as const };
    const changes = { id: "changes", access: "write" as const };
    const held = { databases: false, pluginEndpointId: "crm", pluginGroups: [search, changes] };
    recordPluginToolsLaunch("t1", PROJECT_A);
    const grants = [grant("t1", "crm", held)];

    expect(
      listRelaunchNeeded(
        PROJECT_A,
        [eligible("crm", { ...held, pluginGroups: [changes, search] })],
        () => grants
      )
    ).toEqual([]);
    expect(
      listRelaunchNeeded(
        PROJECT_A,
        [eligible("crm", { ...held, pluginGroups: [search] })],
        () => grants
      )
    ).toEqual([{ terminalId: "t1", pluginDisplayNames: ["CRM"] }]);
    expect(
      listRelaunchNeeded(
        PROJECT_A,
        [eligible("crm", { ...held, pluginGroups: [{ ...search, access: "write" }, changes] })],
        () => grants
      )
    ).toEqual([{ terminalId: "t1", pluginDisplayNames: ["CRM"] }]);
  });
});

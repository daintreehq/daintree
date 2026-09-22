import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import { pluginMcpGrantRegistry } from "../grantRegistry.js";
import {
  isAgentMcpEndpointEnabled,
  listEnabledAgentMcpEndpoints,
  setAgentMcpEndpointEnabled,
} from "../projectEnablement.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);

beforeEach(() => {
  storeMock.data.clear();
  storeMock.get.mockReset().mockImplementation((key: string) => storeMock.data.get(key));
  storeMock.set.mockReset().mockImplementation((key: string, value: unknown) => {
    storeMock.data.set(key, value);
  });
  pluginMcpGrantRegistry.revokeAll();
});

describe("projectEnablement", () => {
  it("is off until the user turns it on, per project", () => {
    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data")).toBe(false);

    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", true);

    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data")).toBe(true);
    expect(isAgentMcpEndpointEnabled(PROJECT_B, "acme.ledger", "data")).toBe(false);
    expect(listEnabledAgentMcpEndpoints(PROJECT_A)).toEqual([
      { pluginInstanceId: "acme.ledger", endpointId: "data" },
    ]);
  });

  it("prunes empty levels when turned off, keeping other projects' answers", () => {
    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", true, 1);
    setAgentMcpEndpointEnabled(PROJECT_B, "acme.ledger", "data", true, 2);

    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", false);

    expect(storeMock.data.get("projectAgentMcpEnablement")).toEqual({
      [PROJECT_B]: { "acme.ledger": { data: { decidedAt: 2 } } },
    });
  });

  it("revokes live credentials for the endpoint in that project when turned off", () => {
    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", true);
    const here = pluginMcpGrantRegistry.issue({
      pluginInstanceId: "acme.ledger",
      endpointId: "data",
      projectId: PROJECT_A,
      terminalId: "t1",
    });
    const elsewhere = pluginMcpGrantRegistry.issue({
      pluginInstanceId: "acme.ledger",
      endpointId: "data",
      projectId: PROJECT_B,
      terminalId: "t2",
    });

    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", false);

    expect(pluginMcpGrantRegistry.authenticate(here.token)).toBeNull();
    expect(pluginMcpGrantRegistry.authenticate(elsewhere.token)).toBe(elsewhere.grant);
  });

  it("keeps consent to an installed plugin away from a project copy with the same manifest id", () => {
    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", true);

    expect(isAgentMcpEndpointEnabled(PROJECT_A, `project__${PROJECT_A}__acme.ledger`, "data")).toBe(
      false
    );
  });

  it("stores and reads an id that collides with an Object.prototype key as a plain key", () => {
    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data", true);
    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "__proto__")).toBe(false);
    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "constructor")).toBe(false);

    setAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "__proto__", true);

    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "__proto__")).toBe(true);
    expect(listEnabledAgentMcpEndpoints(PROJECT_A)).toHaveLength(2);
  });

  it("treats malformed stored entries as off", () => {
    storeMock.data.set("projectAgentMcpEnablement", {
      [PROJECT_A]: {
        "acme.ledger": { data: true, reports: null, empty: {}, bad: { decidedAt: "x" } },
      },
    });
    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "empty")).toBe(false);

    expect(isAgentMcpEndpointEnabled(PROJECT_A, "acme.ledger", "data")).toBe(false);
    expect(listEnabledAgentMcpEndpoints(PROJECT_A)).toEqual([]);
  });

  it("rejects a project id that names no project workspace", () => {
    expect(() => setAgentMcpEndpointEnabled("not-a-project", "acme.ledger", "data", true)).toThrow(
      /project workspace id/
    );
    expect(storeMock.set).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { AgentMcpEndpointRegistry } from "../endpointRegistry.js";
import type { AgentMcpEndpointRegistration } from "../types.js";

function registration(
  pluginInstanceId: string,
  endpointId = "data",
  toolName = "list"
): AgentMcpEndpointRegistration {
  return {
    pluginInstanceId,
    endpointId,
    tools: [{ name: toolName, description: "d", inputSchema: { type: "object" } }],
    invoke: vi.fn(async () => null),
  };
}

describe("AgentMcpEndpointRegistry", () => {
  it("replaces a roster and makes the superseded disposer inert", () => {
    const registry = new AgentMcpEndpointRegistry();
    const first = registration("acme.ledger", "data", "old");
    const second = registration("acme.ledger", "data", "new");
    const disposeFirst = registry.register(first);
    registry.register(second);

    disposeFirst();

    expect(registry.get("acme.ledger", "data")).toBe(second);
  });

  it("drops only the named instance's rosters", () => {
    const registry = new AgentMcpEndpointRegistry();
    registry.register(registration("project__a__acme.ledger"));
    const other = registration("project__b__acme.ledger");
    registry.register(other);

    registry.unregisterPlugin("project__a__acme.ledger");

    expect(registry.get("project__a__acme.ledger", "data")).toBeUndefined();
    expect(registry.get("project__b__acme.ledger", "data")).toBe(other);
  });

  it("notifies on register, dispose and unregister", () => {
    const registry = new AgentMcpEndpointRegistry();
    const listener = vi.fn();
    registry.onDidChange(listener);

    const dispose = registry.register(registration("acme.ledger"));
    dispose();
    registry.register(registration("acme.ledger", "reports"));
    registry.unregisterPlugin("acme.ledger");

    expect(listener.mock.calls).toEqual([
      ["acme.ledger", "data"],
      ["acme.ledger", "data"],
      ["acme.ledger", "reports"],
      ["acme.ledger", "reports"],
    ]);
  });
});

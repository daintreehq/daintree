import { describe, expect, it, vi } from "vitest";
import type { ActionId } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

// ActionService pulls in the shortcut-hint store, keybinding service, and notify
// at module load / dispatch time. Registration only needs the module to import
// cleanly, so stub them out.
vi.mock("../../../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: vi.fn(() => ({ counts: {}, show: vi.fn(), incrementCount: vi.fn() })),
  },
}));
vi.mock("../../../KeybindingService", () => ({
  keybindingService: { getEffectiveCombo: vi.fn(() => null), getDisplayCombo: vi.fn(() => "") },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

// The resource actions reach into the renderer-only client/store layer at module
// load; stub those so the definitions register in a node test.
vi.mock("@/clients", () => ({
  copyTreeClient: {},
  systemClient: {},
  worktreeClient: { resourceAction: vi.fn() },
  projectClient: {},
}));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: vi.fn(() => ({ getState: () => ({ worktrees: new Map() }) })),
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: vi.fn(() => ({})) },
}));
vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: { getState: vi.fn(() => ({ addTerminal: vi.fn() })) },
}));
vi.mock("@/lib/copyTreeFormat", () => ({ DEFAULT_COPYTREE_FORMAT: "xml" }));

import { ActionService } from "../../../ActionService";
import { registerWorktreeResourceActions } from "../worktreeResourceActions";

function registerAll(): ActionService {
  const registry: ActionRegistry = new Map();
  registerWorktreeResourceActions(registry, {
    onAddTerminal: vi.fn(),
  } as unknown as ActionCallbacks);
  const service = new ActionService();
  for (const [, factory] of registry) {
    service.register(factory() as AnyActionDefinition);
  }
  return service;
}

function outputSchema(service: ActionService, id: string): Record<string, unknown> | undefined {
  return service.get(id as ActionId)?.outputSchema as Record<string, unknown> | undefined;
}

// #11533 — worktree.resource.status declares its result shape. A `resultSchema`
// alone never reaches the wire: publication is gated on `mcpOutputSchema`, and
// buildToolOutputSchema drops anything whose top-level type isn't "object".
// Registering through the real ActionService exercises the Zod -> JSON Schema
// conversion, so these assert the *generated* schema rather than the flags.
describe("worktree.resource.status emits a manifest outputSchema (#11533)", () => {
  it("generates an object-typed outputSchema keyed by configured/status", () => {
    const schema = outputSchema(registerAll(), "worktree.resource.status");
    expect(schema).toBeDefined();
    // buildToolOutputSchema discards any schema that isn't object-typed, which
    // is why a discriminated union (emitted as a bare oneOf) can't be used here.
    expect(schema!.type).toBe("object");

    const props = (schema!.properties as Record<string, unknown>) ?? {};
    expect(props.configured).toBeDefined();
    expect(props.status).toBeDefined();

    const required = (schema!.required as string[] | undefined) ?? [];
    expect(required).toEqual(expect.arrayContaining(["configured", "status"]));
  });

  it("advertises every field of the resource status object, and admits null", () => {
    const schema = outputSchema(registerAll(), "worktree.resource.status")!;
    const status = (schema.properties as { status: Record<string, unknown> }).status;

    // `status` is null whenever no status command is configured, so a strict
    // MCP client would reject the unconfigured branch without the null arm.
    expect(JSON.stringify(status)).toContain("null");

    const serialized = JSON.stringify(status);
    for (const field of [
      "lastStatus",
      "lastOutput",
      "error",
      "lastCheckedAt",
      "endpoint",
      "meta",
      "provider",
      "resumedAt",
      "pausedAt",
    ]) {
      expect(serialized).toContain(field);
    }
  });

  it("publishes no outputSchema for the actions that resolve with nothing", () => {
    const service = registerAll();
    for (const id of [
      "worktree.resource.provision",
      "worktree.resource.teardown",
      "worktree.resource.resume",
      "worktree.resource.pause",
      "worktree.resource.connect",
    ]) {
      expect(outputSchema(service, id), `${id} should not advertise an output schema`).toBeUndefined();
    }
  });
});

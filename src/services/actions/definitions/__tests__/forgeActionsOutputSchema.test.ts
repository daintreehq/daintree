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

// forgeActions reaches the renderer-only client/store layer at module load.
vi.mock("@/clients", () => ({ forgeClient: {} }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: vi.fn() } }));

import { ActionService } from "../../../ActionService";
import { registerForgeActions } from "../forgeActions";

function registerAll(): ActionService {
  const registry: ActionRegistry = new Map();
  registerForgeActions(registry, {} as ActionCallbacks);
  const service = new ActionService();
  for (const [, factory] of registry) {
    service.register(factory() as AnyActionDefinition);
  }
  return service;
}

function outputSchema(service: ActionService, id: string): Record<string, unknown> | undefined {
  return service.get(id as ActionId)?.outputSchema as Record<string, unknown> | undefined;
}

function ciStatusBranchProperties(service: ActionService): Record<string, unknown> {
  const schema = outputSchema(service, "forge.getCIStatus")!;
  const ciStatus = (schema.properties as { ciStatus: Record<string, unknown> }).ciStatus;
  // `ciStatus` is a nullable object, which Zod renders as an anyOf branch pair.
  // Pick the object branch — that's the one carrying the roll-up fields.
  const branches = (ciStatus.anyOf as Array<Record<string, unknown>> | undefined) ?? [ciStatus];
  const objectBranch = branches.find((b) => b.type === "object") ?? {};
  return (objectBranch.properties as Record<string, unknown>) ?? {};
}

// #11544 — forge.getCIStatus is the MCP surface for "is this PR green?". It opts
// into structuredContent, so these assert the *generated* JSON Schema rather
// than the literal flag.
describe("forge.getCIStatus advertises a usable MCP outputSchema (#11544)", () => {
  it("generates an object-typed outputSchema", () => {
    const schema = outputSchema(registerAll(), "forge.getCIStatus");
    expect(schema).toBeDefined();
    // buildToolOutputSchema (tierAuth) forwards only object-typed schemas, so a
    // top-level nullable/union here would silently advertise nothing at all.
    expect(schema!.type).toBe("object");
    expect((schema!.properties as Record<string, unknown>).ciStatus).toBeDefined();
  });

  it("keeps the not-found case expressible by making ciStatus nullable", () => {
    const schema = outputSchema(registerAll(), "forge.getCIStatus")!;
    const ciStatus = (schema.properties as { ciStatus: Record<string, unknown> }).ciStatus;
    const branches = (ciStatus.anyOf as Array<Record<string, unknown>> | undefined) ?? [];
    expect(branches.some((b) => b.type === "null")).toBe(true);
    expect(branches.some((b) => b.type === "object")).toBe(true);
  });

  it("exposes the roll-up count fields an agent needs to judge a PR", () => {
    const props = ciStatusBranchProperties(registerAll());
    for (const key of ["state", "total", "passed", "failed", "pending"]) {
      expect(props[key]).toBeDefined();
    }
  });

  it("advertises every CIStatusState the provider can return", () => {
    const props = ciStatusBranchProperties(registerAll());
    const state = props.state as { enum?: string[] };
    // A missing member would make a strict MCP client reject a legitimate
    // response — 'neutral' (no checks configured) especially, since it is the
    // one an agent is most likely to misread as a failure.
    expect(new Set(state.enum ?? [])).toEqual(
      new Set(["success", "failure", "pending", "neutral", "unknown"])
    );
  });

  it("does not advertise the provider transport fields stripped at the IPC boundary", () => {
    const props = ciStatusBranchProperties(registerAll());
    // These are dropped by projectCIStatus in forgeData.ts. Advertising them
    // would promise a caller data that never arrives.
    expect(props.rawData).toBeUndefined();
    expect(props.freshnessToken).toBeUndefined();
    expect(props.notModified).toBeUndefined();
  });

  it("does not require requiredChecksPassing (absent when the provider doesn't gate)", () => {
    const schema = outputSchema(registerAll(), "forge.getCIStatus")!;
    const ciStatus = (schema.properties as { ciStatus: Record<string, unknown> }).ciStatus;
    const branches = (ciStatus.anyOf as Array<Record<string, unknown>> | undefined) ?? [ciStatus];
    const objectBranch = branches.find((b) => b.type === "object") ?? {};
    const required = (objectBranch.required as string[] | undefined) ?? [];
    // The provider omits the key entirely when it doesn't gate on required
    // checks; requiring it would make a strict client reject that response.
    expect(required).not.toContain("requiredChecksPassing");
  });

  // Watchout: adding the flag here must not imply the neighbouring forge reads
  // gained one. They return provider payloads (with rawData) and deliberately
  // stay schema-less until that is projected.
  it("does not emit an outputSchema for forge.getPR or forge.listPRs", () => {
    const service = registerAll();
    expect(outputSchema(service, "forge.getPR")).toBeUndefined();
    expect(outputSchema(service, "forge.listPRs")).toBeUndefined();
  });
});

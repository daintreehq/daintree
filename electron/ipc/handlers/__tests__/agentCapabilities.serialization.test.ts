import { describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(() => ({ agents: {} })),
}));

const ccrConfigServiceMock = vi.hoisted(() => ({
  loadAndApply: vi.fn(() => []),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
}));

vi.mock("../../../store.js", () => ({ store: storeMock }));

vi.mock("../../../services/CcrConfigService.js", () => ({
  CcrConfigService: { getInstance: () => ccrConfigServiceMock },
}));

import { agentCapabilitiesNamespace } from "../agentCapabilities.js";
import { getEffectiveRegistry } from "../../../../shared/config/agentRegistry.js";

type OpName = keyof typeof agentCapabilitiesNamespace.ops;

function callOp(name: OpName, ...args: unknown[]): Promise<unknown> {
  const handler = agentCapabilitiesNamespace.ops[name].handler as (
    ...a: unknown[]
  ) => Promise<unknown>;
  return handler(...args);
}

/**
 * Derived from the live registry rather than hardcoded, so renaming or dropping
 * a built-in agent can't leave this suite probing an id that no longer exists.
 */
const sampleAgentId = Object.keys(getEffectiveRegistry())[0];

describe("agentCapabilities getRegistry serialization (issue #11795)", () => {
  it("cannot put the raw effective registry on the wire", () => {
    // The premise of the fix. Every `AgentResume` variant holds a live function
    // (`args`, `argsForTarget`, `assignSessionIdArgs`), and structuredClone is
    // the same algorithm Electron's IPC serializer uses — so returning the raw
    // registry could never reach the renderer. If this ever stops throwing the
    // projection below has become dead weight and should be revisited, not
    // silently kept. The message is runtime-specific, so it isn't asserted.
    expect(() => structuredClone(getEffectiveRegistry())).toThrow();
  });

  it("returns a payload the IPC serializer can carry", async () => {
    const projected = await callOp("getRegistry");

    expect(() => structuredClone(projected)).not.toThrow();
  });

  it("preserves every agent id and display name", async () => {
    const raw = getEffectiveRegistry();
    const projected = (await callOp("getRegistry")) as Record<string, { name: string }>;

    expect(Object.keys(projected)).toEqual(Object.keys(raw));
    for (const [agentId, entry] of Object.entries(projected)) {
      expect(entry.name).toBe(raw[agentId]!.name);
    }
  });

  it("stays a reduction rather than a passthrough", async () => {
    const raw = getEffectiveRegistry();
    const projected = (await callOp("getRegistry")) as Record<string, object>;

    for (const [agentId, entry] of Object.entries(projected)) {
      // Locking the wire shape is the point: a generic deep function-stripper
      // would clone cleanly while quietly promoting every other config field
      // onto the wire. Widening this is a deliberate edit, never a side effect.
      expect(Object.keys(entry)).toEqual(["name"]);
      expect(Object.keys(entry).length).toBeLessThan(Object.keys(raw[agentId]!).length);
    }
  });
});

describe("agentCapabilities namespace wire safety", () => {
  // Exhaustive by construction: `satisfies` fails to compile when an op is
  // added without deciding what arguments exercise it, so a new op can't slip
  // onto the wire unchecked the way getRegistry did.
  const opArgs = {
    getRegistry: [],
    getAgentIds: [],
    getAgentMetadata: [sampleAgentId],
    isAgentEnabled: [sampleAgentId],
    getCcrPresets: [],
    getResolvedModelList: [sampleAgentId],
  } satisfies Record<OpName, unknown[]>;

  it("has a sample agent id to probe with", () => {
    expect(sampleAgentId).toBeTruthy();
  });

  it.each(Object.keys(opArgs) as OpName[])(
    "%s resolves to a structured-cloneable value",
    async (name) => {
      const value = await callOp(name, ...opArgs[name]);

      expect(() => structuredClone(value)).not.toThrow();
    }
  );
});

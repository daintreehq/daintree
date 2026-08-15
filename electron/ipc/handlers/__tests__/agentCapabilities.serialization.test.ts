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
 * Throws at construction so a missing fixture fails once, loudly, instead of
 * surfacing as a confusing assertion failure in every case below.
 */
const sampleAgentId = (() => {
  const [first] = Object.keys(getEffectiveRegistry());
  if (!first) throw new Error("effective registry is empty — no agent id to probe with");
  return first;
})();

/** Own-property function values are what the IPC serializer chokes on. */
function hasFunctionValue(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some(hasFunctionValue);
}

describe("agentCapabilities getRegistry serialization (issue #11795)", () => {
  it("still holds live functions in the raw registry the projection guards against", () => {
    // Names the actual hazard rather than only its symptom. If configs ever
    // become pure data this fails with "the historical cause is gone", not with
    // a vague clone error — and the projection stays justified on its own terms
    // (a narrow wire contract), so the right response is to update this test,
    // never to widen the handler back to raw configs.
    const raw = getEffectiveRegistry();

    expect(Object.values(raw).some(hasFunctionValue)).toBe(true);
  });

  it("cannot put the raw effective registry on the wire", () => {
    // structuredClone is the same algorithm Electron's IPC serializer uses, so
    // this is the fix's premise: returning the raw registry could never reach
    // the renderer. The thrown message is runtime-specific and isn't asserted.
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
      // A generic deep function-stripper would clone cleanly while quietly
      // promoting every other config field onto the wire. One field, strictly
      // fewer than the config has — paired with the name check above, that
      // pins the payload to exactly the field the consumer reads, without
      // restating the projection's own key list.
      expect(Object.keys(entry)).toHaveLength(1);
      expect(Object.keys(entry).length).toBeLessThan(Object.keys(raw[agentId]!).length);
    }
  });
});

describe("agentCapabilities representative happy-path wire safety", () => {
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

  it.each(Object.keys(opArgs) as OpName[])(
    "%s resolves to a structured-cloneable value",
    async (name) => {
      const value = await callOp(name, ...opArgs[name]);

      expect(() => structuredClone(value)).not.toThrow();
    }
  );
});

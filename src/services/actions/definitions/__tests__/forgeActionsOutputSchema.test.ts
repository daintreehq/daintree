import { describe, expect, it, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
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

/**
 * Pull the object branch out of the nullable `ciStatus` schema.
 *
 * Throws rather than returning a default if the shape isn't what we expect.
 * That matters: the negative assertions below check that fields are ABSENT, so
 * a silent `{}` fallback here would make them pass for the wrong reason if a
 * future Zod release rendered the nullable differently (say `type:
 * ["object","null"]`, or a `$ref` into `$defs`).
 */
function ciStatusObjectBranch(service: ActionService): Record<string, unknown> {
  const schema = outputSchema(service, "forge.getCIStatus");
  if (!schema) throw new Error("forge.getCIStatus has no outputSchema");
  const ciStatus = (schema.properties as Record<string, unknown> | undefined)?.ciStatus as
    Record<string, unknown> | undefined;
  if (!ciStatus) throw new Error("outputSchema has no `ciStatus` property");
  const branches = ciStatus.anyOf as Array<Record<string, unknown>> | undefined;
  if (!branches) {
    throw new Error(
      `expected \`ciStatus\` to be an anyOf union, got: ${JSON.stringify(ciStatus).slice(0, 200)}`
    );
  }
  const objectBranch = branches.find((b) => b.type === "object");
  if (!objectBranch) {
    throw new Error(
      `no object branch in \`ciStatus\` anyOf: ${JSON.stringify(branches).slice(0, 200)}`
    );
  }
  return objectBranch;
}

function ciStatusBranchProperties(service: ActionService): Record<string, unknown> {
  const props = ciStatusObjectBranch(service).properties as Record<string, unknown> | undefined;
  if (!props) throw new Error("`ciStatus` object branch has no properties");
  return props;
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
    const required = (ciStatusObjectBranch(registerAll()).required as string[] | undefined) ?? [];
    // The provider omits the key entirely when it doesn't gate on required
    // checks; requiring it would make a strict client reject that response.
    expect(required).not.toContain("requiredChecksPassing");
    // The always-present fields must stay required, or the schema stops
    // telling a client anything useful about what it can rely on.
    expect(required).toEqual(
      expect.arrayContaining(["state", "total", "passed", "failed", "pending"])
    );
  });

  it("closes the object, which is what makes the IPC-side stripping load-bearing", () => {
    // Zod emits `additionalProperties: false`. A strict MCP client validating
    // structuredContent against this schema would therefore REJECT a response
    // carrying any un-advertised key — so if the handler ever stopped
    // projecting and forwarded the provider's rawData, every strict client
    // would start failing. This is the invariant that makes projectCIStatus
    // load-bearing rather than merely tidy.
    expect(ciStatusObjectBranch(registerAll()).additionalProperties).toBe(false);
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

// ActionService does not validate results against `resultSchema` at runtime —
// the schema is only advertised. So nothing else in the suite would catch the
// projection in `forgeData.ts` drifting away from what MCP clients are told to
// expect. These validate representative payloads against the *generated* schema
// exactly as a strict client would, binding the two together.
describe("forge.getCIStatus results validate against the advertised schema (#11544)", () => {
  function validator(): (payload: unknown) => boolean {
    const schema = outputSchema(registerAll(), "forge.getCIStatus");
    if (!schema) throw new Error("forge.getCIStatus has no outputSchema");
    return new Ajv2020({ strict: false }).compile(schema);
  }

  it("accepts a not-found result", () => {
    expect(validator()({ ciStatus: null })).toBe(true);
  });

  it("accepts a fully-gated status including requiredChecksPassing:false", () => {
    const validate = validator();
    expect(
      validate({
        ciStatus: {
          state: "failure",
          total: 9,
          passed: 5,
          failed: 3,
          pending: 1,
          requiredChecksPassing: false,
        },
      })
    ).toBe(true);
  });

  it("accepts an ungated status that omits requiredChecksPassing", () => {
    const validate = validator();
    expect(
      validate({ ciStatus: { state: "neutral", total: 0, passed: 0, failed: 0, pending: 0 } })
    ).toBe(true);
  });

  it("accepts a red PR with no required checks (state failure, zero counts)", () => {
    // The GitHub provider falls back to the raw rollup when no required checks
    // are configured, so this combination is real and must not be rejected.
    const validate = validator();
    expect(
      validate({ ciStatus: { state: "failure", total: 0, passed: 0, failed: 0, pending: 0 } })
    ).toBe(true);
  });

  it("rejects a payload carrying the provider's rawData", () => {
    // This is the regression that matters: if the IPC projection ever stopped
    // stripping transport fields, strict MCP clients would start rejecting
    // every response. Failing here is how we find out first.
    const validate = validator();
    expect(
      validate({
        ciStatus: {
          state: "success",
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          rawData: { checkRuns: [] },
        },
      })
    ).toBe(false);
  });

  it("rejects an unknown state and a missing count", () => {
    const validate = validator();
    expect(
      validate({ ciStatus: { state: "banana", total: 0, passed: 0, failed: 0, pending: 0 } })
    ).toBe(false);
    expect(validate({ ciStatus: { state: "success", total: 1, passed: 1, failed: 0 } })).toBe(
      false
    );
  });

  it("rejects a bare status that isn't wrapped under ciStatus", () => {
    // Guards the wrapper itself: returning the summary directly would both
    // break this schema and silently disable structuredContent.
    const validate = validator();
    expect(validate({ state: "success", total: 1, passed: 1, failed: 0, pending: 0 })).toBe(false);
  });
});

// #11786 — forge.getChecks is the MCP surface for "which check failed?". Same
// structuredContent contract as getCIStatus, so these assert the generated
// JSON Schema rather than the literal flag.
describe("forge.getChecks advertises a usable MCP outputSchema (#11786)", () => {
  function checksSchema(): Record<string, unknown> {
    const schema = outputSchema(registerAll(), "forge.getChecks");
    if (!schema) throw new Error("forge.getChecks has no outputSchema");
    return schema;
  }

  function checkItemSchema(): Record<string, unknown> {
    const checks = (checksSchema().properties as { checks: Record<string, unknown> }).checks;
    const branches = (checks.anyOf as Array<Record<string, unknown>> | undefined) ?? [];
    const arrayBranch = branches.find((b) => b.type === "array");
    if (!arrayBranch) {
      throw new Error(
        `no array branch in \`checks\` anyOf: ${JSON.stringify(branches).slice(0, 200)}`
      );
    }
    return arrayBranch.items as Record<string, unknown>;
  }

  function validator(): (payload: unknown) => boolean {
    return new Ajv2020({ strict: false }).compile(checksSchema());
  }

  it("generates an object-typed outputSchema", () => {
    // buildToolOutputSchema forwards only object-typed schemas, so a bare
    // nullable array here would advertise nothing at all.
    const schema = checksSchema();
    expect(schema.type).toBe("object");
    expect((schema.properties as Record<string, unknown>).checks).toBeDefined();
  });

  it("keeps the not-found case expressible by making checks nullable", () => {
    const checks = (checksSchema().properties as { checks: Record<string, unknown> }).checks;
    const branches = (checks.anyOf as Array<Record<string, unknown>> | undefined) ?? [];
    expect(branches.some((b) => b.type === "null")).toBe(true);
    expect(branches.some((b) => b.type === "array")).toBe(true);
  });

  it("requires the two fields every check must carry and no more", () => {
    const item = checkItemSchema();
    expect(item.required).toEqual(expect.arrayContaining(["name", "status"]));
    for (const optional of ["conclusion", "required", "detailsUrl"]) {
      expect(item.required as string[]).not.toContain(optional);
    }
  });

  it("does not advertise rawData, which dispatch strips", () => {
    expect((checkItemSchema().properties as Record<string, unknown>).rawData).toBeUndefined();
  });

  it("accepts a not-found result and an empty check list as distinct values", () => {
    const validate = validator();
    expect(validate({ checks: null })).toBe(true);
    expect(validate({ checks: [] })).toBe(true);
  });

  it("accepts a fully-populated failing check", () => {
    expect(
      validator()({
        checks: [
          {
            name: "build",
            status: "completed",
            conclusion: "failure",
            required: true,
            detailsUrl: "https://ci.test/build",
          },
        ],
      })
    ).toBe(true);
  });

  it("accepts a running check that has no conclusion yet", () => {
    expect(validator()({ checks: [{ name: "build", status: "in_progress" }] })).toBe(true);
  });

  it("rejects the provider's raw uppercase vocabulary", () => {
    // The mapper normalizes GitHub's COMPLETED/FAILURE spellings; leaking them
    // through would break a strict MCP client.
    const validate = validator();
    expect(validate({ checks: [{ name: "build", status: "COMPLETED" }] })).toBe(false);
    expect(
      validate({ checks: [{ name: "build", status: "completed", conclusion: "FAILURE" }] })
    ).toBe(false);
  });

  it("rejects a check missing its name or carrying an unknown conclusion", () => {
    const validate = validator();
    expect(validate({ checks: [{ status: "completed" }] })).toBe(false);
    expect(
      validate({ checks: [{ name: "build", status: "completed", conclusion: "exploded" }] })
    ).toBe(false);
  });

  it("rejects a bare array that isn't wrapped under checks", () => {
    expect(validator()([{ name: "build", status: "completed" }])).toBe(false);
  });
});

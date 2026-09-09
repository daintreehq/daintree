/**
 * The write half of the client-metadata capability (#12340), at the action
 * boundary.
 *
 * The store slice owns the policy; what is asserted here is the contract an
 * external MCP client actually sees — that the args schema is closed, that
 * every store rejection surfaces as a thrown error naming what went wrong
 * rather than as a body a model reads as success, and that the result root
 * stays the plain object `mcpOutputSchema` requires.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: panelStoreMock.getState },
}));

import { registerTerminalMetaActions } from "../terminalMetaActions";

function definition(): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  registerTerminalMetaActions(actions, {} as ActionCallbacks);
  const factory = actions.get("terminal.setClientMetadata");
  if (!factory) throw new Error("missing terminal.setClientMetadata");
  return factory() as AnyActionDefinition;
}

function withStore(setPanelClientMetadata: unknown): void {
  panelStoreMock.getState.mockReturnValue({ setPanelClientMetadata });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("terminal.setClientMetadata contract", () => {
  it("advertises a plain object result root, so mcpOutputSchema is not a silent no-op", () => {
    const def = definition();
    const schema = z.toJSONSchema(def.resultSchema as z.ZodType, { io: "output" }) as {
      type?: string;
    };

    // `buildToolOutputSchema` forwards a manifest schema only when its JSON
    // Schema has `type === "object"`; a nullable or optional root renders as an
    // `anyOf` with no `type` and disables structured output with no warning
    // anywhere (#11547).
    expect(schema.type).toBe("object");
    expect(def.mcpOutputSchema).toBe(true);
  });

  it("keeps the opaque record as a free-form map, not an empty object schema", () => {
    const def = definition();
    const schema = z.toJSONSchema(def.argsSchema as z.ZodType, { io: "input" }) as {
      properties?: { clientMetadata?: unknown };
    };
    const field = JSON.stringify(schema.properties?.clientMetadata);

    // A strict client running AJV with `removeAdditional` strips every key out
    // of `z.object({})`, which would delete the very payload this carries.
    expect(field).toContain("additionalProperties");
    expect(field).not.toContain('"properties":{}');
  });

  it("rejects an unknown argument rather than silently ignoring it", () => {
    const parsed = (definition().argsSchema as z.ZodType).safeParse({
      terminalId: "t1",
      clientMetadata: {},
      owned: true,
    });

    expect(parsed.success).toBe(false);
  });

  it("requires the record argument, so a caller cannot half-specify a write", () => {
    const schema = definition().argsSchema as z.ZodType;

    expect(schema.safeParse({ terminalId: "t1" }).success).toBe(false);
    expect(schema.safeParse({ terminalId: "t1", clientMetadata: null }).success).toBe(true);
  });

  it("is hidden from the palette and never captured as a repeatable action", () => {
    const def = definition();

    // It needs a terminal id the palette's empty-args dispatch cannot supply,
    // and a replay would rewrite the last caller's record onto whatever
    // terminal happens to be focused now.
    expect(def.palette).toEqual({ mode: "hidden" });
    expect(def.nonRepeatable).toBe(true);
    expect(def.denyPluginDispatch).toBe(true);
  });
});

describe("terminal.setClientMetadata dispatch", () => {
  it("passes the record through to the store and reports what changed", async () => {
    const setPanelClientMetadata = vi.fn().mockReturnValue({ ok: true, changed: true });
    withStore(setPanelClientMetadata);

    const result = await definition().run(
      { terminalId: "t1", clientMetadata: { session: "gc-1" } },
      {} as never
    );

    expect(setPanelClientMetadata).toHaveBeenCalledWith("t1", { session: "gc-1" });
    expect(result).toEqual({ terminalId: "t1", changed: true });
  });

  it("forwards a null delete verbatim", async () => {
    const setPanelClientMetadata = vi.fn().mockReturnValue({ ok: true, changed: false });
    withStore(setPanelClientMetadata);

    const result = await definition().run({ terminalId: "t1", clientMetadata: null }, {} as never);

    expect(setPanelClientMetadata).toHaveBeenCalledWith("t1", null);
    // An already-absent record is a success, not a rejection: the caller's
    // desired state IS what is stored.
    expect(result).toEqual({ terminalId: "t1", changed: false });
  });

  it("throws a reason the caller can act on for every store rejection", async () => {
    const cases: [string, RegExp][] = [
      ["not-found", /not found/i],
      ["not-eligible", /plugin-owned|tooling-internal/i],
      ["invalid-json", /JSON object/i],
      ["too-deep", /nests deeper/i],
      ["metadata-too-large", /exceeds \d+ bytes/i],
      ["state-too-large", /stored state is full/i],
    ];

    for (const [reason, matcher] of cases) {
      withStore(vi.fn().mockReturnValue({ ok: false, reason }));

      // Thrown rather than returned: the distinction that matters is "the
      // record is now what I asked for" versus "it is not", and an `ok: false`
      // body is the shape most likely to be read as success.
      await expect(
        definition().run({ terminalId: "t1", clientMetadata: {} }, {} as never)
      ).rejects.toThrow(matcher);
    }
  });
});

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  AgentIdSchema,
  AddPanelFocusPolicySchema,
  CopyTreeOptionsSchema,
  FileSearchPayloadSchema,
  TerminalStatusEntrySchema,
  TerminalSpawnSourceSchema,
} from "../schemas";
import { WAIT_UNTIL_IDLE_INPUT_SCHEMA } from "@shared/types/terminalWaitUntilIdle";

/**
 * #11542 moved field semantics out of `//` comments and out of every tool's
 * prose into `.describe()`, on the premise that `.describe()` is what actually
 * reaches an MCP client. These tests hold that premise up.
 *
 * They matter because the failure is silent: a description attached to the
 * wrong link in a zod chain is dropped by `toJSONSchema` without error, so the
 * text simply stops being advertised while the source still reads as if it were
 * documented. Every assertion here therefore goes through the real conversion
 * rather than reading `.description` off the schema object.
 */

/**
 * The slice of an emitted JSON Schema these tests read. Parsing the output
 * rather than asserting a type onto it means a conversion that stopped
 * producing an object — or produced `{}`, the documented failure mode for a
 * transformed schema — fails loudly here instead of quietly yielding
 * `undefined` and passing a `not.toBe("")` check for the wrong reason.
 */
const EmittedSchema = z.object({
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  properties: z.record(z.string(), z.object({ description: z.string().optional() })).optional(),
});

/** The exact conversion `ActionService.zodSchemaToJsonSchema` performs. */
function emit(schema: z.ZodType): z.infer<typeof EmittedSchema> {
  return EmittedSchema.parse(
    z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "any",
      reused: "inline",
      cycles: "ref",
      target: "draft-2020-12",
    })
  );
}

const described = (schema: z.ZodType): string => emit(schema).description ?? "";

describe("shared field descriptions reach the emitted JSON Schema", () => {
  it("survives a union, so agent-id guidance is advertised", () => {
    // A union is the shape most likely to lose metadata, since the description
    // sits on the wrapper rather than on either arm.
    expect(described(AgentIdSchema)).not.toBe("");
  });

  it("survives .optional() on an enum", () => {
    // `.optional()` wraps the enum, so a description attached before the wrap
    // has to be carried outward for a client to ever see it.
    expect(described(AddPanelFocusPolicySchema.optional())).toBe(
      described(AddPanelFocusPolicySchema)
    );
    expect(described(TerminalSpawnSourceSchema.optional())).not.toBe("");
  });

  it("survives .default(), which rewraps the schema again", () => {
    expect(described(TerminalSpawnSourceSchema.default("mcp"))).not.toBe("");
  });

  it("advertises every enum member it explains", () => {
    // Derived from the emitted schema rather than a copied literal: if a member
    // is added to the enum and left unexplained, the description stops covering
    // what the client is told it may send.
    const emitted = emit(AddPanelFocusPolicySchema);
    const members = emitted.enum ?? [];
    expect(members.length).toBeGreaterThan(0);

    const text = emitted.description ?? "";
    expect(members.filter((member) => !text.includes(member))).toEqual([]);
  });
});

describe("argument descriptions carry the semantics prose no longer states", () => {
  it("puts the worktree fallback and its failure on the search directory", () => {
    // This is the sentence #11542 found duplicated across tools. It belongs to
    // the argument, once — so the argument is where it is asserted.
    const cwd = emit(FileSearchPayloadSchema).properties?.cwd?.description ?? "";

    expect(cwd).toMatch(/active worktree/i);
    expect(cwd).toMatch(/fails|error/i);
  });

  it("warns that the file query does not search contents", () => {
    // The mistake this prevents — reaching for a file-name search expecting
    // grep — is invisible from the type, which is just a string.
    const query = emit(FileSearchPayloadSchema).properties?.query?.description ?? "";
    expect(query).toMatch(/name|path/i);
    expect(query).toMatch(/content/i);
  });

  it("explains why an empty scope list is rejected rather than ignored", () => {
    const scope = emit(CopyTreeOptionsSchema).properties?.scopePaths?.description ?? "";
    expect(scope).not.toBe("");
    // The trap is that an empty list looks like "no scoping" but would mean
    // "copy everything", so the description has to name both readings.
    expect(scope).toMatch(/empty/i);
  });

  it("keeps the terminal-id contract on the raw wait schema", () => {
    // This one is a hand-written JSON Schema rather than a zod conversion, so
    // it is the one place a describe() regression would not be caught above.
    const props = EmittedSchema.parse(WAIT_UNTIL_IDLE_INPUT_SCHEMA).properties ?? {};

    expect(props.terminalId?.description ?? "").not.toBe("");
    expect(props.timeoutMs?.description ?? "").not.toBe("");
  });
});

describe("result descriptions explain what a value cannot say for itself", () => {
  it("marks the parsed check result as not an exit code", () => {
    // The whole hazard: `passed` reads like a process result but is scraped
    // from output. Losing this text turns a heuristic into an authority.
    const entry = emit(TerminalStatusEntrySchema).properties?.lastCheckResult?.description ?? "";
    expect(entry).toMatch(/exit code/i);
  });

  it("distinguishes a null exit code from a missing one", () => {
    const exitCode = emit(TerminalStatusEntrySchema).properties?.exitCode?.description ?? "";
    expect(exitCode).toMatch(/signal/i);
    expect(exitCode).toMatch(/running|absen/i);
  });
});

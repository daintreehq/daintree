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
 * The slice of an emitted JSON Schema these tests read. Parsing rather than
 * asserting a type onto the output keeps the reads honest: a conversion that
 * stopped returning an object, or returned a description of the wrong type,
 * fails here rather than silently yielding `undefined`.
 *
 * Every field is optional, so this does NOT by itself prove anything was
 * emitted — `parse({})` succeeds. The assertions below carry that weight.
 */
const EmittedSchema = z.object({
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  properties: z.record(z.string(), z.object({ description: z.string().optional() })).optional(),
});

/**
 * The exact conversion `ActionService.computeSchemas` performs. The mode is not
 * cosmetic: `argsSchema` is converted as input and `resultSchema` as output, so
 * asserting a result schema in input mode would verify text the client is never
 * sent.
 */
function emit(schema: z.ZodType, io: "input" | "output" = "input"): z.infer<typeof EmittedSchema> {
  return EmittedSchema.parse(
    z.toJSONSchema(schema, {
      io,
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
    // Polarity matters: "searches contents" would satisfy a bare /content/.
    expect(query).toMatch(/not (?:file )?contents|never contents/i);
  });

  it("explains why an empty scope list is rejected rather than ignored", () => {
    const scope = emit(CopyTreeOptionsSchema).properties?.scopePaths?.description ?? "";
    // The trap is that an empty list looks like "no scoping" but would mean
    // "copy everything", so the description has to say it is refused — not
    // merely mention the word "empty".
    expect(scope).toMatch(/empty list is rejected|rejected rather than/i);
  });

  // #11731: a caller sent `includePaths: ["src/worldgen", ...]`, every directory
  // existed, and the call returned zero files with no error — then burned 13
  // rounds guessing. Both spellings of the selection feed the SDK's single
  // `filter`, which matches against FILE paths, so a bare directory matches
  // nothing. The wire description is the only place that rule can be learned,
  // and a caller reads the description of whichever field it reached for.
  it.each(["includePaths", "filter"])(
    "warns on %s that a folder needs a glob, and where a folder belongs instead",
    (field) => {
      const description = emit(CopyTreeOptionsSchema).properties?.[field]?.description ?? "";

      expect(description).toMatch(/patterns match file paths/i);
      // Both halves of the contrast, not just the rule: "a folder needs a glob"
      // is advice a caller cannot act on without seeing the two forms side by
      // side, which is exactly what the working `worktree.copyTree` text shows.
      expect(description).toContain("src/panels/**");
      expect(description).toMatch(/not 'src\/panels'/);
      // The redirect matters as much as the warning — the caller's real intent
      // was a folder, and `scopePaths` is the field that takes one.
      expect(description).toMatch(/scopePaths/);
    }
  );

  it("keeps the union and traversal guidance the folder rule was added beside", () => {
    const includePaths = emit(CopyTreeOptionsSchema).properties?.includePaths?.description ?? "";

    // Regression guard on the reword itself. None of this is recoverable from
    // anywhere else on the wire: #11722's union with `filter` is invisible from
    // the types, and the traversal contrast is what stops a caller reaching for
    // `scopePaths` when it genuinely wants patterns matched worktree-wide.
    expect(includePaths).toMatch(/curated bundle/i);
    expect(includePaths).toMatch(/combined with `filter`/i);
    expect(includePaths).toMatch(/does not restrict traversal/i);
  });

  it("says a scope path is literal, so the folder rule does not carry over to it", () => {
    const scope = emit(CopyTreeOptionsSchema).properties?.scopePaths?.description ?? "";

    // The inverse trap, and the one the fix above could create: a caller that
    // has just learned "a folder needs a glob" carries '/**' over to the field
    // that walks literal paths, where it matches nothing either.
    expect(scope).toMatch(/not glob patterns/i);
    expect(scope).toMatch(/literal file or directory paths/i);
    expect(scope).toMatch(/prefer this over[^.]*folder/i);
  });

  it("keeps the terminal-id contract on the hand-written wait schema", () => {
    // A hand-written JSON Schema rather than a zod conversion, so none of the
    // propagation above applies to it. Note this constant is NOT what the
    // registered wait action advertises — that action builds its own zod
    // argsSchema, which is covered cohort-wide by the description-presence
    // guard in actionDefinitions.quality.test.ts. This asserts the shipped
    // constant the MCP server re-exports, which would otherwise go unchecked.
    const props = EmittedSchema.parse(WAIT_UNTIL_IDLE_INPUT_SCHEMA).properties ?? {};

    expect(props.terminalId?.description ?? "").not.toBe("");
    expect(props.timeoutMs?.description ?? "").not.toBe("");
  });
});

describe("result descriptions explain what a value cannot say for itself", () => {
  // Converted as OUTPUT, matching `computeSchemas`. `terminal.getStatus` sets
  // `mcpOutputSchema: true`, so this text is genuinely advertised rather than
  // documentation that stops at the manifest.
  const statusProperties = () => emit(TerminalStatusEntrySchema, "output").properties ?? {};

  it("marks the parsed check result as not an exit code", () => {
    // The whole hazard: the parsed result reads like a process outcome but is
    // scraped from output. Losing this text turns a heuristic into an
    // authority, so the polarity is the assertion — a description claiming it
    // IS an exit code would satisfy a bare /exit code/.
    expect(statusProperties().lastCheckResult?.description ?? "").toMatch(
      /rather than from a process exit code|not (?:an? )?(?:authoritative )?exit code/i
    );
  });

  it("distinguishes a null exit code from a missing one", () => {
    const exitCode = statusProperties().exitCode?.description ?? "";
    expect(exitCode).toMatch(/signal/i);
    expect(exitCode).toMatch(/running|absen/i);
  });

  it("explains a per-entry error rather than letting it read as a whole-call failure", () => {
    expect(statusProperties().error?.description ?? "").not.toBe("");
  });
});

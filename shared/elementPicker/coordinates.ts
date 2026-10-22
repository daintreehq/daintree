import { z } from "zod";

/**
 * Every runtime that reports a source position numbers it its own way: Svelte's
 * `__svelte_meta` is 1-based lines and 0-based columns, a V8 stack frame is
 * 1-based in both, a source map is 1-based lines and 0-based columns again. A
 * position is therefore stored in the convention it was read in and says which
 * one that is. Converting is the host's job, done once it has the file, and a
 * position that silently changed base is a line off with nothing to show for it.
 *
 * Columns are UTF-16 code units in every runtime we read, so that is the only
 * unit accepted; a byte or code-point column would need its own variant.
 */

export const COORDINATE_CONVENTIONS = {
  svelteMeta: { lineBase: 1, columnBase: 0 },
  v8StackFrame: { lineBase: 1, columnBase: 1 },
  sourceMap: { lineBase: 1, columnBase: 0 },
} as const;

/** Far past any real file; it exists so a page cannot hand the host an unbounded number. */
export const MAX_SOURCE_COORDINATE = 10_000_000;

const BaseSchema = z.union([z.literal(0), z.literal(1)]);
const CoordinateSchema = z.number().int().nonnegative().max(MAX_SOURCE_COORDINATE);

/**
 * A position, or a range when `end` is present. `end` is exclusive and shares
 * the start's convention, so a range cannot mix bases.
 */
export const SourceLocationSchema = z
  .strictObject({
    lineBase: BaseSchema,
    columnBase: BaseSchema,
    columnUnit: z.literal("utf16"),
    line: CoordinateSchema,
    column: CoordinateSchema,
    end: z.strictObject({ line: CoordinateSchema, column: CoordinateSchema }).optional(),
  })
  .superRefine((location, ctx) => {
    const below = (line: number, column: number) =>
      line < location.lineBase || column < location.columnBase;
    if (below(location.line, location.column)) {
      ctx.addIssue({ code: "custom", message: "position is below its convention's base" });
    }
    const end = location.end;
    if (!end) return;
    if (below(end.line, end.column)) {
      ctx.addIssue({
        code: "custom",
        path: ["end"],
        message: "end is below its convention's base",
      });
    }
    if (end.line < location.line || (end.line === location.line && end.column < location.column)) {
      ctx.addIssue({ code: "custom", path: ["end"], message: "end precedes start" });
    }
  });
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

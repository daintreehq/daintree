import { z } from "zod";

/**
 * The Site Builder domain model — the frozen vocabulary every part of the
 * plugin shares: what a selection is, what the source underneath it is, which
 * edits that source supports, and what a completed edit is allowed to claim.
 *
 * Two rules this file exists to enforce, both of which the specification treats
 * as release blockers:
 *
 * 1. A rendered element, the markup that defines it, and the invocation that
 *    produced this particular copy of it are three different things. Collapsing
 *    them is how a visual editor writes to the wrong source node.
 * 2. "Saved" is not "rendered" and neither is "the CSS for this class exists".
 *    Each is observed separately and reported separately.
 */

/** Offsets are UTF-16 code-unit indices into the raw, un-preprocessed `.svelte` bytes. */
export const SourceRangeSchema = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .strict()
  .refine((r) => r.end >= r.start, { message: "end must not precede start" });
export type SourceRange = z.infer<typeof SourceRangeSchema>;

/**
 * A location as Svelte's dev runtime reports it on `__svelte_meta`: a path
 * relative to the Vite project root in POSIX form, a 1-indexed line and a
 * 0-indexed column. Stored exactly as reported — converting to an offset needs
 * the file, which only the main side has.
 */
export const SourceLocationSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive(),
    column: z.number().int().nonnegative(),
  })
  .strict();
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

/**
 * Entry kinds Svelte's `add_svelte_meta` pushes onto its dev stack. `unknown`
 * keeps a future compiler release from invalidating a stored selection — an
 * unrecognised kind degrades the breadcrumb, it does not fail the resolve.
 */
export const AncestryKindSchema = z.enum([
  "component",
  "each",
  "if",
  "await",
  "key",
  "render",
  "snippet",
  "unknown",
]);
export type AncestryKind = z.infer<typeof AncestryKindSchema>;

export const AncestryEntrySchema = z
  .object({
    kind: AncestryKindSchema,
    location: SourceLocationSchema,
    /** Present on `component` entries: the tag as written at the call site. */
    componentTag: z.string().min(1).optional(),
    /**
     * True for framework-generated files (`.svelte-kit/generated/**`). These are
     * real ancestors but never user-editable, so the breadcrumb hides them and
     * no edit may target them.
     */
    generated: z.boolean(),
  })
  .strict();
export type AncestryEntry = z.infer<typeof AncestryEntrySchema>;

/**
 * How confidently a rendered node was tied back to source.
 *
 * - `exact` — the definition node was found and its invocation is known.
 * - `definition-only` — the markup is known; which call site produced this copy is not.
 * - `ambiguous` — more than one candidate matched; no edit may proceed.
 * - `visual-only` — `{@html}`, canvas, a closed shadow root, a cross-origin frame.
 */
export const MappingConfidenceSchema = z.enum([
  "exact",
  "definition-only",
  "ambiguous",
  "visual-only",
]);
export type MappingConfidence = z.infer<typeof MappingConfidenceSchema>;

/** The three honest editing states from the functional spec's §3.3. */
export const EditSupportSchema = z.enum(["direct", "agent-assisted", "inspect-only"]);
export type EditSupport = z.infer<typeof EditSupportSchema>;

/**
 * Why a property is not directly editable. Carried to the UI so a disabled
 * control can explain itself instead of being a greyed-out mystery.
 */
export const UnsupportedReasonSchema = z.enum([
  "dynamic-expression",
  "class-directive",
  "spread-attribute",
  "data-driven",
  "snippet-supplied",
  "dependency-owned",
  "generated-file",
  "ambiguous-invocation",
  "unmapped-content",
  "unsupported-framework-version",
]);
export type UnsupportedReason = z.infer<typeof UnsupportedReasonSchema>;

export const EditCapabilitySchema = z
  .object({
    /** `text`, `classes`, `attributes`, `props` — the four editable surfaces. */
    surface: z.enum(["text", "classes", "attributes", "props"]),
    support: EditSupportSchema,
    reason: UnsupportedReasonSchema.optional(),
  })
  .strict();
export type EditCapability = z.infer<typeof EditCapabilitySchema>;

export const RectSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();
export type Rect = z.infer<typeof RectSchema>;

/**
 * The markup that defines a rendered node, plus what else that same markup
 * renders right now.
 *
 * `renderedOccurrences` is the guard against the single most dangerous claim a
 * visual editor can make. Three pricing cards drawn by one `<article>` in one
 * component share one source range: editing it changes all three. The count is
 * what the UI must show before it lets a "style this element" control write.
 */
export const DefinitionSchema = z
  .object({
    location: SourceLocationSchema,
    range: SourceRangeSchema,
    tagName: z.string().min(1),
    /** sha256 of the defining file's bytes when the selection was resolved. */
    revision: z.string().regex(/^[0-9a-f]{64}$/),
    /** How many nodes in the live document resolve to this same source range. */
    renderedOccurrences: z.number().int().positive(),
    /** The count is a floor: the page was too large to count every copy. */
    renderedOccurrencesAtLeast: z.literal(true).optional(),
  })
  .strict();
export type Definition = z.infer<typeof DefinitionSchema>;

/** Longest source excerpt a read-only surface shows; longer ones end in `…`. */
export const MAX_WRITTEN_CHARS = 240;

export const SelectedNodeSchema = z
  .object({
    /**
     * Document-local identity minted by the guest runtime. Never a stable
     * application key and never persisted across a document epoch — an HMR
     * update replaces the DOM nodes, so this is only meaningful within one epoch.
     */
    runtimeOccurrenceId: z.string().min(1),
    definition: DefinitionSchema.nullable(),
    /** Nearest `component` ancestry entry: the call site that rendered this copy. */
    invocation: AncestryEntrySchema.nullable(),
    /** Full chain, innermost first, generated frames included but flagged. */
    ancestry: z.array(AncestryEntrySchema),
    mapping: MappingConfidenceSchema,
    /** Human label for the breadcrumb, e.g. `button "Start Pro"`. */
    label: z.string(),
    bounds: z.array(RectSchema),
    capabilities: z.array(EditCapabilitySchema),
    /**
     * The editable values, decoded by main from the real AST. The view shows and
     * edits these and addresses operations by `definition.range`; it never
     * re-derives tokens or text from source itself. A second parser in the view
     * disagreed with the compiler on entities, whitespace and expressions, and
     * one disagreement removed a different class token than the one clicked.
     * Null for a surface that is not directly editable.
     */
    surfaces: z
      .object({
        classes: z
          .object({ tokens: z.array(z.string()) })
          .strict()
          .nullable(),
        text: z.object({ text: z.string() }).strict().nullable(),
      })
      .strict(),
    /**
     * How a surface that can't be edited here is written, verbatim from the
     * source: `class={cn(base, active && "on")}`, `{title}`. Shown so the
     * limitation is understandable, never offered as an editable value.
     */
    written: z
      .object({
        classes: z
          .string()
          .max(MAX_WRITTEN_CHARS + 1)
          .nullable(),
        text: z
          .string()
          .max(MAX_WRITTEN_CHARS + 1)
          .nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SelectedNode = z.infer<typeof SelectedNodeSchema>;

export const ViewportSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
  })
  .strict();
export type Viewport = z.infer<typeof ViewportSchema>;

export const SiteSelectionSchema = z
  .object({
    selectionId: z.string().min(1),
    workspaceSessionId: z.string().min(1),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    /** Absolute path of the SvelteKit app root — not necessarily the git root. */
    appRoot: z.string().min(1),
    previewPanelId: z.string().min(1),
    /**
     * Increments on every document replacement (navigation, full reload). A
     * selection from an older epoch is stale by definition and never re-targeted.
     */
    documentEpoch: z.number().int().nonnegative(),
    routeId: z.string().nullable(),
    /** Already redacted of query values before it reaches any model or log. */
    displayedUrl: z.string(),
    viewport: ViewportSchema,
    nodes: z.array(SelectedNodeSchema),
    capturedAt: z.string().datetime(),
  })
  .strict();
export type SiteSelection = z.infer<typeof SiteSelectionSchema>;

/**
 * The responsive range an edit is meant to affect. Deliberately separate from
 * the preview width: looking at 390px does not make the next edit mobile-only.
 * Bounds are resolved from the project's own Tailwind theme, never assumed.
 */
export const ResponsiveIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("base") }).strict(),
  z
    .object({
      kind: z.literal("range"),
      /** Tailwind variant chain that expresses this interval, e.g. `md:max-lg`. */
      variant: z.string().min(1),
      minWidth: z.number().int().nonnegative().optional(),
      maxWidthExclusive: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type ResponsiveIntent = z.infer<typeof ResponsiveIntentSchema>;

/**
 * The deterministic operations. Anything not expressible here is an agent task,
 * not a quietly widened mutation — a generic "write this file" operation is
 * exactly what the specification forbids.
 */
export const EditOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("set_literal_text"),
      /** Range of the single `Text` node being replaced. */
      range: SourceRangeSchema,
      text: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_class_tokens"),
      /** Range of the class attribute's `Text` value. */
      range: SourceRangeSchema,
      add: z.array(z.string().min(1)),
      remove: z.array(z.string().min(1)),
      responsive: ResponsiveIntentSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_literal_attribute"),
      range: SourceRangeSchema,
      name: z.string().min(1),
      value: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_literal_prop"),
      range: SourceRangeSchema,
      name: z.string().min(1),
      /** Scalars only. Objects, functions and expressions are agent work. */
      value: z.union([z.string(), z.number(), z.boolean()]),
    })
    .strict(),
]);
export type EditOperation = z.infer<typeof EditOperationSchema>;

export const SiteEditErrorCodeSchema = z.enum([
  "STALE_SOURCE",
  "UNSUPPORTED_EXPRESSION",
  "AMBIGUOUS_INVOCATION",
  "NODE_NOT_FOUND",
  "INVALID_CANDIDATE",
  "UNSUPPORTED_ATTRIBUTE",
  "GENERATED_FILE",
  "OUT_OF_SCOPE",
  "WRITER_BUSY",
  "PERMISSION_REQUIRED",
  "PARSE_FAILED",
]);
export type SiteEditErrorCode = z.infer<typeof SiteEditErrorCodeSchema>;

/**
 * What an applied edit is allowed to claim, and no more.
 *
 * `sourceSaved` is proved by the write. `previewRefreshed` is proved by the
 * guest acknowledging a later document revision. `stylesGenerated` is proved by
 * reading computed style back out of the guest — a class reaching the DOM does
 * not mean Tailwind emitted a rule for it. Anything unproven stays `null`
 * rather than defaulting to true.
 */
export const EditReceiptSchema = z
  .object({
    transactionId: z.string().min(1),
    file: z.string().min(1),
    beforeRevision: z.string().regex(/^[0-9a-f]{64}$/),
    afterRevision: z.string().regex(/^[0-9a-f]{64}$/),
    appliedRange: SourceRangeSchema,
    sourceSaved: z.literal(true),
    previewRefreshed: z.boolean().nullable(),
    stylesGenerated: z.boolean().nullable(),
    /** Occurrences the edit was known to affect, from `renderedOccurrences`. */
    affectedOccurrences: z.number().int().positive(),
    appliedAt: z.string().datetime(),
  })
  .strict();
export type EditReceipt = z.infer<typeof EditReceiptSchema>;

/** Supported-baseline floors. Read from installed packages, never from semver ranges. */
export const SUPPORTED_BASELINE = {
  svelteMajor: 5,
  kitMajor: 2,
  tailwindMajor: 4,
} as const;

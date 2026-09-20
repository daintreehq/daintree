import { z } from "zod";

/**
 * The Site Builder domain model — the frozen vocabulary every part of the
 * plugin shares: what a selection is, and what the source underneath it is.
 *
 * The one rule this file exists to enforce, which the specification treats as
 * a release blocker: a rendered element, the markup that defines it, and the
 * invocation that produced this particular copy of it are three different
 * things. Collapsing them is how a tool names the wrong source node.
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
     * real ancestors but nothing the user authored, so the breadcrumb hides them
     * and no request names them.
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
 * - `ambiguous` — more than one candidate matched, so none is claimed.
 * - `visual-only` — `{@html}`, canvas, a closed shadow root, a cross-origin frame.
 */
export const MappingConfidenceSchema = z.enum([
  "exact",
  "definition-only",
  "ambiguous",
  "visual-only",
]);
export type MappingConfidence = z.infer<typeof MappingConfidenceSchema>;

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
 * tool like this can make. Three pricing cards drawn by one `<article>` in one
 * component share one source range: changing it changes all three. The count
 * is what the UI and the agent prompt both have to say before anyone acts on
 * "this element".
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
    /**
     * Evidence about how this element was placed, for deciding whether a
     * selection may be re-acquired after the page changed under it. Absent when
     * the page reported no structure, or the source could not walk it.
     *
     * `levelCounts` is how many countable siblings sat at each level of the
     * path, outermost first — see `resolveElementByStructure`, which explains
     * what it can and cannot rule out. `agrees` says whether walking the shape
     * landed on the same place `location` names. A fresh pick keeps a same-tag
     * stamp the shape would have placed elsewhere, because the user watched it
     * land; nothing should be re-adopted on the user's behalf while those two
     * disagree.
     *
     * Deliberately unbounded above: a count is host-derived from a contained
     * read, the array is capped at the path's depth, and a real document can
     * hold more siblings than any ceiling worth guessing at. A ceiling here
     * turned a 700 KB page — well inside the source cap — into a failed
     * selection, which is evidence costing more than it is worth.
     */
    shape: z
      .object({
        levelCounts: z.array(z.number().int().nonnegative()).min(1).max(64),
        agrees: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Definition = z.infer<typeof DefinitionSchema>;

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
    /** The page's own label for the breadcrumb, collapsed to one line, e.g. `button "Start Pro"`. */
    label: z.string(),
    bounds: z.array(RectSchema),
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
    /**
     * What the page said it was serving, carried back unverified — the route
     * the project model matched is on {@link PagePlace}, and that is the one
     * to trust.
     */
    routeId: z.string().nullable(),
    /**
     * Redacted before it reaches any model or log: query values, userinfo and
     * the fragment are gone, and anything unparseable or off `http(s)` is the
     * placeholder instead of a slice of itself. Still the page's to influence
     * — it can push any path it likes — so treat it as an observation.
     */
    displayedUrl: z.string(),
    viewport: ViewportSchema,
    nodes: z.array(SelectedNodeSchema),
    capturedAt: z.string().datetime(),
  })
  .strict();
export type SiteSelection = z.infer<typeof SiteSelectionSchema>;

/** Supported-baseline floors. Read from installed packages, never from semver ranges. */
export const SUPPORTED_BASELINE = {
  svelteMajor: 5,
  kitMajor: 2,
  tailwindMajor: 4,
} as const;

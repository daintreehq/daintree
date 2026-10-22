import { z } from "zod";
import { SourceFileRefSchema } from "./resolution.js";

/**
 * What the app's project layout says about the page a preview shows: which
 * files the framework's router renders it from, and which toolchain the app
 * has installed. Context beside a selection, never part of one: it is read
 * from the files on disk and matched the way the router would match, not
 * reported by the running router, so a route file is evidence about the page
 * and never a source location for an element.
 */

/** The meta-frameworks whose project layout the host can read. Fixed: a page never names one. */
export const ProjectAdapterIdSchema = z.enum(["sveltekit"]);
export type ProjectAdapterId = z.infer<typeof ProjectAdapterIdSchema>;

export const PROJECT_CONTEXT_LIMITS = {
  routeFiles: 64,
  reasons: 16,
  diagnostics: 32,
  diagnosticFiles: 16,
} as const;

/** POSIX, worktree-relative; `.` is the worktree itself. */
const WorktreePathSchema = z.string().min(1).max(1024);

export const RouteFileSchema = z.strictObject({
  role: z.enum(["page", "layout", "data"]),
  file: SourceFileRefSchema,
});
export type RouteFile = z.infer<typeof RouteFileSchema>;

export const ProjectRouteSchema = z.strictObject({
  routeId: z.string().min(1).max(1024),
  files: z.array(RouteFileSchema).max(PROJECT_CONTEXT_LIMITS.routeFiles),
});
export type ProjectRoute = z.infer<typeof ProjectRouteSchema>;

/** Something the route tree says that the framework would reject, or that could not be read. */
export const ProjectDiagnosticSchema = z.strictObject({
  code: z.enum(["unresolved-layout-reset", "duplicate-route-id", "traversal-truncated"]),
  message: z.string().min(1).max(2000),
  files: z.array(WorktreePathSchema).max(PROJECT_CONTEXT_LIMITS.diagnosticFiles),
});
export type ProjectDiagnostic = z.infer<typeof ProjectDiagnosticSchema>;

const InstalledVersionSchema = z.string().min(1).max(256).nullable();

export const SvelteKitProjectContextSchema = z.strictObject({
  adapter: z.literal("sveltekit"),
  /** The app the context is about. */
  appPath: WorktreePathSchema,
  /**
   * Null when the route tree names no page for the URL, and also when it
   * cannot be trusted to: a base path the config computes, a routes directory
   * the config would have to be run to find, or a dynamic match on a walk that
   * stopped before reaching a static route that might have won.
   */
  route: ProjectRouteSchema.nullable(),
  /** Where the route tree was read from, and how much of it. */
  routes: z.strictObject({
    directory: WorktreePathSchema,
    source: z.enum(["svelte.config", "vite.config", "default", "unresolved"]),
    /** `kit.paths.base`: "" when unset, null when the config computes it. */
    basePath: z.string().max(1024).nullable(),
    complete: z.boolean(),
  }),
  /**
   * Installed versions, read from each package's own manifest. The verdict is
   * a diagnostic, not a gate: `untested` says which installed major the bundled
   * compiler was never proven against, in `reasons`.
   */
  toolchain: z.strictObject({
    versions: z.strictObject({
      svelte: InstalledVersionSchema,
      kit: InstalledVersionSchema,
      tailwind: InstalledVersionSchema,
      vite: InstalledVersionSchema,
    }),
    verdict: z.enum(["tested", "untested"]),
    reasons: z.array(z.string().min(1).max(1000)).max(PROJECT_CONTEXT_LIMITS.reasons),
    /** Declared but not installed: the remedy is an install, not an upgrade. */
    missingInstall: z.array(z.enum(["svelte", "kit", "tailwind", "vite"])).max(4),
  }),
  diagnostics: z.array(ProjectDiagnosticSchema).max(PROJECT_CONTEXT_LIMITS.diagnostics),
});

export const ProjectContextSchema = z.discriminatedUnion("adapter", [
  SvelteKitProjectContextSchema,
]);
export type ProjectContext = z.infer<typeof ProjectContextSchema>;

/**
 * How a request for context ended. It never rejects: context is optional, and
 * a caller holding a selection has nothing to recover with.
 */
export const ProjectContextOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("described"), context: ProjectContextSchema }),
  /** No adapter reads this app: not a meta-framework app, or no readable `package.json`. */
  z.strictObject({ status: z.literal("none") }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum(["cancelled", "budget-exhausted", "busy", "failed", "unknown-workspace"]),
  }),
]);
export type ProjectContextOutcome = z.infer<typeof ProjectContextOutcomeSchema>;

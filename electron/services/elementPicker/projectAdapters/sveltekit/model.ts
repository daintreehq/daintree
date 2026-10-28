/**
 * The project model's own shapes. The legacy plugin's wire schemas
 * (`ProjectModelResultSchema` and friends) describe the same objects; its
 * handlers return these, so a drift between the two fails its typecheck and
 * `project-model-wire.test.ts`.
 */

/**
 * What the bundled compiler was tested against, not what the user may do.
 * Nothing gates on it: `untested` names each package that reads as a version
 * the parser was never proven against.
 */
export type SupportVerdict = { level: "tested" } | { level: "untested"; reasons: string[] };

export interface RouteNode {
  /** SvelteKit route id, e.g. `/products/[slug]`. Route groups excluded. */
  routeId: string;
  /** Worktree-relative path of the `+page.svelte`, when one exists. */
  pageFile: string | null;
  layoutFiles: string[];
  /** Worktree-relative load modules that feed the page, outermost layout first. */
  dataFiles?: string[];
  /** True when the route id carries at least one `[param]`. */
  dynamic: boolean;
  /** Endpoint-only routes are not navigable pages. */
  endpointOnly: boolean;
}

/**
 * Where the routes directory came from. `svelte.config` and `vite.config` are
 * readings; `default` is Kit's own fallback applying to a config that sets
 * nothing; `unresolved` is the refusal — a config exists that we would have to
 * execute to read, so the path beside it is a fallback and not a finding.
 */
export type RoutesDirectorySource = "svelte.config" | "vite.config" | "default" | "unresolved";

/** Something the routes tree says that SvelteKit would reject, or that we could not read. */
export interface RouteDiagnostic {
  code: "unresolved-layout-reset" | "duplicate-route-id" | "traversal-truncated";
  message: string;
  /** Worktree-relative paths the diagnostic is about. */
  files: string[];
}

export interface ProjectModel {
  appRoot: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  versions: {
    svelte: string | null;
    kit: string | null;
    tailwind: string | null;
    vite: string | null;
  };
  support: SupportVerdict;
  routes: RouteNode[];
  /** `kit.paths.base`: "" when unset, null when the config computes it. */
  basePath?: string | null;
  /** Where `routes` was read from: a read config, Kit's default, or a refusal to guess. */
  routesDirectory?: {
    /** Worktree-relative, like every other path on the wire. */
    path: string;
    source: RoutesDirectorySource;
  };
  /** Walks that stopped early and trees SvelteKit would reject. */
  routeDiagnostics?: RouteDiagnostic[];
}

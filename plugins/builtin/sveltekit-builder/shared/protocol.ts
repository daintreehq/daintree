import { z } from "zod";
import { RectSchema, SiteSelectionSchema, SourceLocationSchema, ViewportSchema } from "./model.js";

/**
 * The Site Builder wire contract. Three boundaries meet here and all three are
 * frozen for the life of a protocol version:
 *
 * - renderer view → plugin main, over the plugin channel bridge (`CHANNELS`);
 * - plugin main → renderer view, pushed (`PUSH_CHANNELS`);
 * - preview guest → host, over the site-preview bridge (`GuestEnvelopeSchema`).
 *
 * The guest half is the security-relevant one. The page is untrusted: it may be
 * an application the user is debugging, and a same-origin compromise can forge
 * anything it sends. Everything arriving from the guest is therefore an
 * *observation* — the host re-resolves source identity itself and never accepts
 * a file path, range or revision the page supplied.
 *
 * Ownership is split along the process boundary, and each half owns exactly
 * one thing:
 *
 * - **The renderer view owns the live preview.** It binds, detaches and
 *   switches mode through `window.electron.sitePreview` — which is a renderer
 *   IPC surface and cannot be reached from plugin main — names the guest
 *   runtime by its adapter id (`GUEST_ADAPTER_ID`; the host loads the asset),
 *   and receives guest events. Nothing about the preview binding crosses
 *   `CHANNELS`.
 * - **Plugin main owns source truth.** It resolves the app, reads and parses
 *   files through the scope-contained `host.fs` and turns guest observations
 *   into source identity. It reads only: the agent the user sends a selection
 *   to is what writes, and main's job is to notice when it has. It never
 *   touches the preview.
 */

export const PLUGIN_ID = "daintree.sveltekit-builder";
/** The dev preview tool the renderer registers; the toggle command names it. */
export const BUILDER_TOOL_ID = `${PLUGIN_ID}.builder`;
/** Declared in `contributes.commands`; bound by main on first dispatch. */
export const TOGGLE_BUILDER_ACTION_ID = "toggle-builder";

/**
 * Bumped whenever a guest-visible shape changes. The host refuses envelopes
 * from a runtime built against a different major, which is what keeps a stale
 * injected script from a previous app version talking to a newer host.
 */
export const GUEST_PROTOCOL_VERSION = 1;

/**
 * The host-registered guest adapter this plugin binds to. The host owns the
 * runtime asset and resolves this id to it — the plugin sends the id and never
 * the body. Declared under `contributes.guestAdapters` in `plugin.json`, which
 * is what main registers at startup; the protocol-drift test pins the two.
 */
export const GUEST_ADAPTER_ID = "daintree.sveltekit-builder.guest";

export const CHANNELS = {
  /** Resolve the SvelteKit app for a worktree and open a source workspace on it. */
  workspaceOpen: "workspace-open",
  /** Release a source workspace and the file watches it holds. */
  workspaceClose: "workspace-close",
  /** Turn guest observations into source identity against current file bytes. */
  selectionResolve: "selection-resolve",
  /** Read a bounded source excerpt for the identity card / source peek. */
  /** Detected app roots, versions, package manager and route tree. */
  projectModel: "project-model",
  /** Whether a worktree holds a SvelteKit app at all, without opening a workspace. */
  detectApps: "detect-apps",
  /** Where the components used at these call sites are written, read from source. */
  componentDefinitions: "component-definitions",
  sourceRevisions: "source-revisions",
} as const satisfies Record<string, string>;

/**
 * Main pushes only what main alone can observe. Selection, binding and preview
 * readiness are the renderer's own knowledge, so they are not pushed back to it.
 */
export const PUSH_CHANNELS = {
  /** A file under an open workspace changed outside the builder, e.g. an agent wrote it. */
  sourceChanged: "push-source-changed",
  /** A main-side problem the panel should surface inline. */
  issue: "push-issue",
} as const satisfies Record<string, string>;

/* -------------------------------------------------------------------------- */
/* Guest → host                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the guest reports about one node. Note what is absent: no file path, no
 * source range, no revision. The guest reports the raw `__svelte_meta` it read
 * plus geometry; the host turns that into source identity. A page that lies
 * about its own `__svelte_meta` can at worst point the inspector at the wrong
 * element of its own project, never at another file.
 */
export const GuestNodeObservationSchema = z
  .object({
    runtimeOccurrenceId: z.string().min(1).max(128),
    /** Verbatim `__svelte_meta.loc`, absent when the node has none. */
    loc: SourceLocationSchema.nullable(),
    /** Verbatim `__svelte_meta.parent` chain, innermost first, capped. */
    ancestry: z
      .array(
        z
          .object({
            type: z.string().min(1).max(32),
            file: z.string().min(1).max(1024),
            line: z.number().int().positive(),
            column: z.number().int().nonnegative(),
            componentTag: z.string().min(1).max(128).optional(),
          })
          .strict()
      )
      .max(64),
    tagName: z.string().min(1).max(64),
    /** Count of live nodes sharing this node's `loc`, computed in the guest. */
    sameLocCount: z.number().int().positive().max(100_000),
    /** The page stopped counting at its scan bound: `sameLocCount` is a floor. */
    sameLocCountPartial: z.literal(true).optional(),
    /**
     * Which of those this node is, in document order. Lets the host ask the
     * page for the same rendered occurrence again. Optional: an older runtime
     * does not report it, and the host then asks for the first.
     */
    locIndex: z.number().int().nonnegative().max(100_000).optional(),
    /**
     * Where the node sits in its template: outermost first, each step the tag
     * and the index among the elements at that level that belong to the same
     * frame (`ancestry[0]`). Shape, for when the location the page stamped is
     * a neighbour's (a hydrated page); reported only where the page can vouch
     * for whose elements it counted. Optional: an older runtime does not
     * report it.
     */
    structure: z
      .object({
        /** The file the template was compiled from; an unstamped node takes it from its template's stamped kin. */
        file: z.string().min(1).max(1024),
        path: z
          .array(
            z
              .object({
                tag: z.string().min(1).max(64),
                index: z.number().int().nonnegative().max(100_000),
              })
              .strict()
          )
          .min(1)
          .max(64),
      })
      .strict()
      .optional(),
    label: z.string().max(200),
    bounds: z.array(RectSchema).max(32),
    /** True when the node sits inside `{@html}`, canvas, or a shadow root. */
    unmapped: z.boolean(),
  })
  .strict();
export type GuestNodeObservation = z.infer<typeof GuestNodeObservationSchema>;

export const GuestEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("documentReady"),
      routeId: z.string().max(512).nullable(),
      url: z.string().max(2048),
      viewport: ViewportSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("selectionChanged"),
      nodes: z.array(GuestNodeObservationSchema).max(32),
      /**
       * Who moved the selection: the user (a click, a key, Escape), the
       * document (a node the page was showing left it), or the host's own
       * `reselect` — which is how a component named in the trail is picked.
       */
      cause: z.enum(["user", "document", "reselect"]).optional(),
      /** Present when the nodes are one component invocation's rendered roots. */
      scope: z.literal("component").optional(),
      /**
       * The call site of the component that was selected, as it appears on the
       * primary node's parent chain. A location, not a position in the chain: a
       * dropped or truncated frame must not make it name a different component.
       * A wrapper with no element of its own shares its roots with the component
       * inside it, so the roots alone cannot say which one was meant.
       */
      component: z
        .object({
          file: z.string().min(1).max(1024),
          line: z.number().int().positive(),
          column: z.number().int().nonnegative(),
          /** The tag it was written as at that call site. */
          name: z.string().min(1).max(128),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hoverChanged"),
      node: GuestNodeObservationSchema.nullable(),
    })
    .strict(),
  z
    .object({ type: z.literal("mappingRevisionSeen"), revision: z.string().min(1).max(128) })
    .strict(),
  z
    .object({
      type: z.literal("runtimeIssue"),
      code: z.enum(["no-svelte-meta", "not-dev-build", "overlay-blocked", "capacity", "internal"]),
      detail: z.string().max(512),
    })
    .strict(),
  /**
   * What the page's Svelte dev metadata turned out to support, probed once per
   * document from the first stamped elements found. `locations` is whether an
   * element names its source; `ancestry` whether the parent chain names the
   * component invocations above it. A shape the runtime does not recognise
   * reports false rather than nothing, so the host narrows what it offers
   * instead of assuming the whole major behaves like the version it was built
   * against.
   */
  z
    .object({
      type: z.literal("metadataProbed"),
      locations: z.boolean(),
      ancestry: z.boolean(),
    })
    .strict(),
]);
export type GuestEvent = z.infer<typeof GuestEventSchema>;

/**
 * Every guest message is wrapped. The host validates all five envelope fields
 * before it looks at the payload: a mismatched protocol version, an unknown
 * session, a stale epoch, a replayed sequence number or an oversized body is
 * dropped without interpretation.
 */
export const GuestEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(GUEST_PROTOCOL_VERSION),
    /** Host-issued, per-binding. Not a credential — it scopes, it does not authorise. */
    sessionId: z.string().min(1).max(128),
    documentEpoch: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    event: GuestEventSchema,
  })
  .strict();
export type GuestEnvelope = z.infer<typeof GuestEnvelopeSchema>;

/** Hard ceiling on one envelope, enforced before parsing. */
export const MAX_GUEST_MESSAGE_BYTES = 256 * 1024;

/* -------------------------------------------------------------------------- */
/* View → main                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the bundled compiler was tested against, not what the user may do.
 * The builder traces and hands off identically either way — nothing gates on
 * this — so it is a diagnostic: `untested` says which package reads as a
 * version we never proved the parser against, and the reasons name it.
 */
export const SupportVerdictSchema = z.discriminatedUnion("level", [
  z.object({ level: z.literal("tested") }).strict(),
  z
    .object({
      level: z.literal("untested"),
      /** Human-readable, already specific: names the package and version found. */
      reasons: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);
export type SupportVerdict = z.infer<typeof SupportVerdictSchema>;

export const WorkspaceOpenArgsSchema = z
  .object({
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    /**
     * Absolute worktree path. Supplied by the view, which knows the worktree it
     * is showing; main never trusts it as authority — every read and write goes
     * through `host.fs`, which realpath-contains it to the declared scopes.
     */
    worktreePath: z.string().min(1),
    /** Omit to auto-detect; required when the worktree holds more than one app. */
    appRoot: z.string().min(1).optional(),
    /**
     * The dev preview panel the workspace serves. Pushes about the workspace —
     * a source file changing under it, a main-side issue — go to this panel
     * alone, so a builder on another preview never sees them.
     */
    previewPanelId: z.string().min(1).max(256),
  })
  .strict();
export type WorkspaceOpenArgs = z.infer<typeof WorkspaceOpenArgsSchema>;

export const WorkspaceOpenResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      workspaceSessionId: z.string().min(1),
      appRoot: z.string().min(1),
      support: SupportVerdictSchema,
    })
    .strict(),
  /** More than one app in the worktree — the user must choose one. */
  z
    .object({
      status: z.literal("ambiguous"),
      appRoots: z.array(z.string().min(1)).min(2),
    })
    .strict(),
  /** No SvelteKit app found under this worktree. */
  z.object({ status: z.literal("no-app") }).strict(),
]);
export type WorkspaceOpenResult = z.infer<typeof WorkspaceOpenResultSchema>;

export const WorkspaceCloseArgsSchema = z
  .object({ workspaceSessionId: z.string().min(1) })
  .strict();

export const WorkspaceCloseResultSchema = z.object({ closed: z.boolean() }).strict();

const CallSiteSchema = z
  .object({
    file: z.string().min(1).max(1024),
    line: z.number().int().positive(),
    column: z.number().int().nonnegative(),
  })
  .strict();

export const ComponentDefinitionsArgsSchema = z
  .object({
    workspaceSessionId: z.string().min(1),
    callSites: z.array(CallSiteSchema).max(64),
  })
  .strict();

export const ComponentDefinitionsResultSchema = z
  .object({
    definitions: z.array(
      CallSiteSchema.extend({
        name: z.string().min(1).max(128).nullable(),
        definedIn: z.string().min(1).max(1024).nullable(),
        /** Revision of the call site's file as main read it for this answer. */
        revision: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
        /** Revision of `definedIn` as main read it for this answer. */
        definedInRevision: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
      }).strict()
    ),
  })
  .strict();

export const SourceRevisionsArgsSchema = z
  .object({
    workspaceSessionId: z.string().min(1),
    /** App-relative files. */
    files: z.array(z.string().min(1).max(1024)).max(128),
  })
  .strict();

export const SourceRevisionsResultSchema = z
  .object({
    revisions: z.array(
      z
        .object({
          file: z.string().min(1).max(1024),
          /** Revision of the bytes on disk now; null when the file can't be read here. */
          revision: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .nullable(),
        })
        .strict()
    ),
  })
  .strict();

export const DetectAppsArgsSchema = z
  .object({
    /**
     * The workspace discovery reads through. Naming it — rather than leaning on
     * the plugin's ambient filesystem, which follows the focused window — is
     * what lets a preview on a background worktree get a true answer.
     */
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    /** Absolute worktree path; contained by the scope above, never authority itself. */
    worktreePath: z.string().min(1),
  })
  .strict();
export const DetectAppsResultSchema = z
  .object({ appCount: z.number().int().nonnegative() })
  .strict();

/** Args for the channels that only need to name their workspace. */
export const WorkspaceScopedArgsSchema = z
  .object({ workspaceSessionId: z.string().min(1) })
  .strict();
export const ProjectModelArgsSchema = WorkspaceScopedArgsSchema;

export const SelectionResolveArgsSchema = z
  .object({
    workspaceSessionId: z.string().min(1),
    /** The preview the observations came from; the view owns that binding. */
    previewPanelId: z.string().min(1),
    documentEpoch: z.number().int().nonnegative(),
    routeId: z.string().nullable(),
    url: z.string().max(2048),
    viewport: ViewportSchema,
    nodes: z.array(GuestNodeObservationSchema).max(32),
  })
  .strict();
export type SelectionResolveArgs = z.infer<typeof SelectionResolveArgsSchema>;

export const SelectionResolveResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), selection: SiteSelectionSchema }).strict(),
  /** The document moved on while we resolved — the caller reselects, never retargets. */
  z
    .object({
      status: z.literal("stale"),
      /**
       * What the page's location for the node actually holds in the file, when
       * that is what made it stale: the tag the page reported, and the tag that
       * starts there in the source — null when nothing does. A page that was
       * server-rendered can tag an element with a neighbour's location (Svelte's
       * dev `add_locations` counts a child component's root while hydrating),
       * and the caller has to be able to say that rather than "the page moved".
       */
      mismatch: z
        .object({
          file: z.string().min(1),
          line: z.number().int().positive(),
          column: z.number().int().nonnegative(),
          reported: z.string().min(1),
          found: z.string().min(1).nullable(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export type SelectionMismatch = NonNullable<
  Extract<z.infer<typeof SelectionResolveResultSchema>, { status: "stale" }>["mismatch"]
>;
export type SelectionResolveResult = z.infer<typeof SelectionResolveResultSchema>;

export const RouteNodeSchema = z
  .object({
    /** SvelteKit route id, e.g. `/products/[slug]`. Route groups excluded. */
    routeId: z.string().min(1),
    /** Worktree-relative path of the `+page.svelte`, when one exists. */
    pageFile: z.string().min(1).nullable(),
    layoutFiles: z.array(z.string().min(1)),
    /** Worktree-relative load modules that feed the page, outermost layout first. */
    dataFiles: z.array(z.string().min(1)).optional(),
    /** True when the route id carries at least one `[param]`. */
    dynamic: z.boolean(),
    /** Endpoint-only routes are not navigable pages. */
    endpointOnly: z.boolean(),
  })
  .strict();
export type RouteNode = z.infer<typeof RouteNodeSchema>;

export const ProjectModelResultSchema = z
  .object({
    appRoot: z.string().min(1),
    packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "unknown"]),
    versions: z
      .object({
        svelte: z.string().nullable(),
        kit: z.string().nullable(),
        tailwind: z.string().nullable(),
        vite: z.string().nullable(),
      })
      .strict(),
    support: SupportVerdictSchema,
    routes: z.array(RouteNodeSchema),
    /** `kit.paths.base`: "" when unset, null when the config computes it. */
    basePath: z.string().nullable().optional(),
  })
  .strict();
export type ProjectModel = z.infer<typeof ProjectModelResultSchema>;

/* -------------------------------------------------------------------------- */
/* Main → view (push)                                                         */
/* -------------------------------------------------------------------------- */

export const SourceChangedPushSchema = z
  .object({
    workspaceSessionId: z.string().min(1),
    /** Worktree-relative POSIX path of the file that changed. */
    file: z.string().min(1),
    /** Revision now on disk, or null when the file is gone. */
    revision: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();
export type SourceChangedPush = z.infer<typeof SourceChangedPushSchema>;

export const IssuePushSchema = z
  .object({
    severity: z.enum(["warning", "error"]),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export type { SelectedNode, SiteSelection } from "./model.js";

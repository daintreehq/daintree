import { GLOBAL_ASSISTANT_TOOL_IDS } from "../../../shared/config/globalAssistant.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { MCP_EXTERNAL_OMITTED_ARGS } from "../../../shared/config/mcpExternalTierAllowlist.js";
import { RemoteHostWindowOnlyError, WorkspaceBindingError } from "./rendererBridge.js";
import { getExternalBaseManifest } from "./baseManifest.js";
import {
  shouldExposeTool,
  type SessionSurfacePolicy,
  buildToolInputSchema,
  buildAnnotations,
  buildToolOutputSchema,
} from "./tierAuth.js";
import type { SessionContext } from "./sessionContext.js";
import type { SessionServerDeps } from "./sessionServerDeps.js";
import { routeBindingMcpError, sessionGoneError } from "./sessionRouteErrors.js";

export type ResolveManifest = (
  label: string
) => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>;

export function createManifestResolver(
  deps: Pick<SessionServerDeps, "getCachedManifest" | "requestManifest">
): ResolveManifest {
  const { getCachedManifest, requestManifest } = deps;

  /**
   * The action manifest this session's tool surface is built from.
   *
   * Prefer a live fetch so runtime action-set changes (plugin enable/disable)
   * are reflected. On failure (renderer bridge unavailable / timed out /
   * destroyed) fall back to the last-known cached manifest instead of failing
   * the whole request (#9892). For pinned sessions (#7003) getCachedManifest
   * always returns null, so they correctly fail closed rather than serve
   * another window's tool surface. `=== null` (not `!manifest`) so an empty
   * manifest — a valid zero-tool surface — is not misread as "unavailable".
   *
   * Snapshot the fallback BEFORE the await: getCachedManifest() reads the live
   * session→WebContents map, and a pinned session can be torn down (map entry
   * deleted) while requestManifest() is in flight. Reading it after the await
   * would then see the session as unpinned and return the shared cache —
   * another window's tool surface — defeating #7003. Taken synchronously here,
   * the request is still in flight so the pin holds.
   *
   * Shared by `tools/list` and `mcp.surface` so the two cannot describe
   * different manifests: a surface report built off a stale cache while the
   * listing served a live fetch would be exactly the drift the report exists to
   * detect (#11549). The one place they separate is a workspace-bound session
   * with no reachable view (#12082) — `mcp.surface` is a tool call, so it meets
   * the bound pre-dispatch guard and reports the unreachable route before ever
   * arriving here, which is the honest answer for a report about what this
   * session can reach.
   */
  const resolveManifest = async (
    label: string
  ): Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]> => {
    const cachedFallback = getCachedManifest();
    try {
      return await requestManifest();
    } catch (err) {
      // A workspace this session cannot currently reach is not a reason to have
      // no tools (#12082). The workspace id outlives every view, so the route
      // comes back the moment the user opens that workspace — and a client told
      // "no tools" at discovery has no way to notice when it does. Answer from
      // the host's own base surface instead, and let the per-call route report
      // the truth about reachability.
      //
      // Emphatically NOT `cachedFallback`: that describes whichever other
      // window last reported a manifest, which is the cross-workspace leak the
      // bound path exists to prevent. The base surface is generated from the
      // action registry at commit time and describes nobody's view.
      if (err instanceof WorkspaceBindingError) {
        return getExternalBaseManifest();
      }
      // Only windows on a remote host are open (#13285). This machine's tools
      // are still this machine's: list them, and let each call name the host
      // it refuses to reach into.
      if (err instanceof RemoteHostWindowOnlyError) {
        return getExternalBaseManifest();
      }
      // A dead *pin* still is a dead end (#11789). The session's identity is
      // the destroyed WebContents, not a workspace it can re-resolve, so there
      // is no later state in which this succeeds — and serving a cached
      // manifest would answer `tools/list` from a view this session can no
      // longer reach. Surface SESSION_BINDING_GONE in `data` so a client can
      // tell "reconnect and rebind" from "retry in a moment".
      const routed = routeBindingMcpError(err);
      if (routed) throw routed;
      if (cachedFallback === null) {
        throw new McpError(ErrorCode.InternalError, "Action manifest unavailable");
      }
      console.warn(`[MCP] ${label} using cached manifest after live fetch failed:`, err);
      return cachedFallback;
    }
  };

  return resolveManifest;
}

export function registerListToolsHandler(
  server: Server,
  session: SessionContext,
  deps: Pick<SessionServerDeps, "sessionStore" | "noteToolListRoute">,
  resolveManifest: ResolveManifest
): void {
  const { sessionId, sessionSurface, isGlobalSession, hostCallOffered, assistantCallerNow } =
    session;
  const { sessionStore } = deps;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Resolve the tier before fetching anything (#11799). Two reasons to gate
    // here rather than after the await: a dead session should not cost a
    // manifest fetch, and `resolveManifest` can itself throw
    // SESSION_BINDING_GONE — which would answer "your workspace went away" to a
    // caller whose actual problem is that its session did.
    const tier = sessionStore.getTier(sessionId);
    // Throw rather than answer with an empty list: `{ tools: [] }` is a
    // well-formed, cacheable "you have no tools", indistinguishable from a
    // legitimately empty surface and carrying no hint that reconnecting is the
    // fix.
    if (tier === null) throw sessionGoneError();
    // A route that moved while the fetch was out is fetched again from where it
    // went (#13350): the old route's answer could land after the re-list the
    // move's notice asks for, and the client keeps whichever list came last.
    // Once only; a route still moving is left to the notice.
    let manifest!: Awaited<ReturnType<typeof resolveManifest>>;
    for (let attempt = 1; ; attempt++) {
      const routeMoved = deps.noteToolListRoute?.();
      try {
        manifest = await resolveManifest("tools/list");
      } catch (err) {
        if (attempt === 1 && routeMoved?.()) continue;
        throw err;
      }
      if (attempt === 1 && routeMoved?.()) continue;
      break;
    }
    // Origin read once for the whole listing, and the same way the dispatch
    // gate reads it, so a tool withheld here is refused there (#12407).
    const listSurface: SessionSurfacePolicy = {
      ...sessionSurface,
      rendererOwnedOrigin: sessionStore.isRendererOwnedOrigin(sessionId),
      hostCall: hostCallOffered(),
      assistantCaller: assistantCallerNow() !== null,
    };
    const globalSession = isGlobalSession();
    const tools = manifest
      .filter(
        (entry) =>
          shouldExposeTool(entry, tier, listSurface) &&
          (!globalSession || GLOBAL_ASSISTANT_TOOL_IDS.has(entry.id))
      )
      .map((entry) => {
        const outputSchema = buildToolOutputSchema(entry);
        const _meta =
          entry.examples && entry.examples.length > 0 ? { examples: entry.examples } : undefined;
        return {
          name: entry.id,
          description: entry.description,
          // An api-key client is not shown arguments that need a pane of its
          // own; it would be refused them anyway.
          inputSchema: buildToolInputSchema(
            entry,
            tier === "external" ? MCP_EXTERNAL_OMITTED_ARGS[entry.id] : undefined
          ),
          annotations: buildAnnotations(entry),
          ...(outputSchema ? { outputSchema } : {}),
          ...(_meta ? { _meta } : {}),
        };
      });

    return { tools };
  });
}

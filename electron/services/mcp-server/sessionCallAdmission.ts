import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { dispatchCarriesRecipeId } from "../../../shared/utils/dispatchRecipeId.js";
import {
  readDispatchTerminalCommand,
  readDispatchTerminalCwd,
  TERMINAL_LAUNCH_ACTION_ID,
} from "../../../shared/utils/dispatchTerminalCommand.js";
import { isGenericNativeGrantEligible } from "../../../shared/config/nativeGrantUsePolicies.js";
import { OWNED_TWIN_TOOLS } from "../../../shared/config/helpAssistantTierAllowlists.js";
import {
  TIER_NOT_PERMITTED_CODE,
  CONFIRMATION_REQUIRED_CODE,
  minimumPermittingTier,
  buildToolError,
} from "./shared.js";
import {
  isWithheldFromBoundSession,
  isWithheldFromRelaySession,
  isTierPermitted,
  isApprovalRequestable,
  type TargetPolicySessionSnapshot,
  getReachableActionIds,
  readSearchLimit,
  readListPaging,
  readRequestedActionId,
  INTROSPECTION_TOOL_IDS,
  ACTIONS_SEARCH_DEFAULT_LIMIT,
} from "./tierAuth.js";
import { ASSISTANT_CONTROL_TOOL_IDS } from "../../../shared/types/assistantControl.js";
import { HOST_CONTROL_TOOL_IDS } from "../../../shared/types/hostControl.js";
import type { SessionServerDeps } from "./sessionServerDepsContract.js";
import type { GrantCache } from "./grantCache.js";
import type { SessionStore } from "./sessionStore.js";
import type { CallAuditWriter, CallFacts, CallGate, CallerAdmission } from "./sessionCallFacts.js";
import type { SessionSurfacePolicy } from "./tierAuth.js";
import { PROJECT_RUN_COMMAND_TOOL } from "./sessionToolIds.js";

export const PROJECT_RUN_COMMAND_REFUSAL =
  "project.runCommand is only available to Daintree's own assistant.";
export const ASSISTANT_CONTROL_REFUSAL = "Only a Daintree Assistant can find or start assistants.";

/**
 * The surface an introspection call is answered against (#11525): the tier's
 * reach widened by every live grant, then narrowed to what this caller may
 * run. Built per call; the bound-workspace ceiling narrows it further.
 */
export function buildCallIntrospectionSurface(
  grantCache: GrantCache,
  sessionSurface: Readonly<SessionSurfacePolicy>,
  hostCallOffered: () => boolean,
  facts: CallFacts,
  call: CallerAdmission & {
    readonly confirmationsSkipped: boolean;
    readonly searchLimit: ReturnType<typeof readSearchLimit>;
    readonly listPaging: ReturnType<typeof readListPaging>;
  }
) {
  const { sessionId, args, tier, rendererOwnedOrigin } = facts;
  const {
    commandRunnerCaller,
    assistantControlCaller,
    confirmationsSkipped,
    searchLimit,
    listPaging,
  } = call;
  // Snapshotted once and reused for both the permitted set and the
  // policy record (#11910), so the surface a lookup is filtered against
  // and the authorization it reports can never describe two different
  // instants.
  const perToolGrantedActionIds = new Set<string>(
    grantCache.getLiveGrants(sessionId).map((grant) => grant.toolId)
  );
  // Filtered to what the dispatch gate would actually honour: a grant
  // listing a per-resolved-target tool buys nothing, because
  // `peekNativeGrant` refuses it (#12121). Naming it here would produce
  // the discoverable-but-uncallable state #11585 rejects — an agent
  // would find `terminal.killAll` in `actions.search`, then be told
  // TIER_NOT_PERMITTED when it called it.
  const nativeGrantedActionIds = new Set<string>(
    grantCache
      .getLiveNativeGrants(sessionId)
      .flatMap((grant) => [...grant.allowedTools])
      .filter((toolId) => isGenericNativeGrantEligible(toolId))
  );
  const permittedActionIds = new Set<string>([
    ...getReachableActionIds(tier, rendererOwnedOrigin, sessionSurface.paneApproval === true),
    ...perToolGrantedActionIds,
    ...nativeGrantedActionIds,
  ]);
  // The host tools are offered only to this machine's own assistants (#13493),
  // whatever its tier or grants; discovery agrees.
  if (!hostCallOffered()) {
    for (const id of HOST_CONTROL_TOOL_IDS) permittedActionIds.delete(id);
  }
  // A grant never makes the command runner callable, so it never makes it findable;
  // a relayed session that may run it finds it, whatever its tier list says.
  if (commandRunnerCaller) permittedActionIds.add(PROJECT_RUN_COMMAND_TOOL);
  else permittedActionIds.delete(PROJECT_RUN_COMMAND_TOOL);
  // Likewise the assistant tools, for exactly the assistants that may call them (#13496).
  for (const id of ASSISTANT_CONTROL_TOOL_IDS) {
    if (assistantControlCaller) permittedActionIds.add(id);
    else permittedActionIds.delete(id);
  }
  // A relayed session finds nothing it would be refused (#13493).
  if (sessionSurface.relay === true) {
    for (const id of [...permittedActionIds]) {
      if (isWithheldFromRelaySession(id)) permittedActionIds.delete(id);
    }
  }
  return {
    permittedActionIds,
    callerLimit: searchLimit ?? ACTIONS_SEARCH_DEFAULT_LIMIT,
    requestedActionId: readRequestedActionId(args),
    ...(listPaging ? { listPaging } : {}),
    policySnapshot: {
      tier,
      // Grant issuance gates on the origin too, which is why the
      // policy record carries it rather than re-deriving it.
      rendererOwnedOrigin,
      relay: sessionSurface.relay === true,
      paneApproval: sessionSurface.paneApproval === true,
      paneSkipConfirmations: sessionSurface.paneSkipConfirmations === true,
      hostCall: hostCallOffered(),
      assistantControl: assistantControlCaller,
      perToolGrantedActionIds,
      nativeGrantedActionIds,
      confirmationsSkipped,
    } satisfies TargetPolicySessionSnapshot,
  };
}

export type CallIntrospectionSurface = ReturnType<typeof buildCallIntrospectionSurface>;

/** What admitted a call, and what its dispatch still owes for it. */
export interface CallAdmission {
  readonly paneApproval: boolean;
  readonly grantIssuedAt: number | undefined;
  readonly nativeGrantId: string | undefined;
  readonly authorizedWithoutNativeGrant: boolean;
  readonly approvalRequired: boolean;
}

export function admitToolCall(
  deps: Pick<
    SessionServerDeps,
    "notifyTierMismatch" | "recordDenial" | "clearDenialState" | "notifySessionRevoked"
  > & {
    readonly sessionStore: Pick<
      SessionStore,
      "grantCache" | "sessionWebContentsMap" | "isRendererOwnedOrigin" | "revokeSession"
    >;
  },
  sessionSurface: Readonly<SessionSurfacePolicy>,
  facts: CallFacts,
  callers: CallerAdmission,
  appendAuditRecord: CallAuditWriter
): CallGate<CallAdmission> {
  const { sessionId, actionId, args, tier, startedAt, capturedTurnId, rendererOwnedOrigin } = facts;
  const { commandRunnerCaller, assistantControlCaller } = callers;
  const { sessionStore, notifyTierMismatch, recordDenial, clearDenialState, notifySessionRevoked } =
    deps;
  // Layered authorization (#8442):
  //   1. Static tier floor (`TIER_ALLOWLISTS`) — core/full membership
  //      stays the default. The "Always allow" project setting
  //      elevates the session tier so this check passes for everything
  //      below the chosen tier.
  //   2. Per-`(sessionId, toolId)` grant cache — the "Approve once" flow
  //      mints time-bounded grants that authorise a single tool without
  //      elevating the whole session. If the static check denies but a
  //      live grant exists, the dispatch proceeds and the grant's TTL
  //      is refreshed on success.
  //
  //   3. Native session-scoped automation grants (#10648) — the only layer
  //      that both widens past the floor AND pre-authorises the
  //      `danger: "confirm"` modal. Because that second job answers a
  //      different question from "may this call run at all", the lookup is
  //      independent of whichever layer admitted the call (#11878).
  //
  // The order means a session whose static tier already permits the action
  // never consults the per-tool grant cache — those grants only widen the
  // floor and never bypass confirmation, so they have nothing to add once
  // the floor allows the call. Native grants are not ordered that way: see
  // the peek below for why nesting them under any one admission source is
  // what made them unreachable in the first place.
  // A relayed session is refused what it is never listed (#13493), whatever
  // its tier, and no grant stands in for that: it has none to consult.
  const relayWithheld = sessionSurface.relay === true && isWithheldFromRelaySession(actionId);
  const tierPermitted =
    !relayWithheld &&
    (actionId === PROJECT_RUN_COMMAND_TOOL
      ? commandRunnerCaller
      : ASSISTANT_CONTROL_TOOL_IDS.has(actionId)
        ? assistantControlCaller
        : isTierPermitted(tier, actionId, rendererOwnedOrigin));
  // An agent pane's tier is an auto-approval line, not a ceiling (#12692).
  const paneApproval = sessionSurface.paneApproval === true;
  let grantIssuedAt: number | undefined;
  // Set when a native session-scoped automation grant (#10648) authorized
  // this call. Captured here so the post-dispatch path can refresh the
  // grant's TTL window, and so the `danger: "confirm"` modal is bypassed —
  // a native grant is an explicit user approval of the tool's scope.
  let nativeGrantId: string | undefined;
  // True once something OTHER than a native grant has admitted this call —
  // the static floor, or a per-tool "Approve once" grant. It decides two
  // things below: whether a missing native grant is fatal, and how a lost
  // one is handled at the consume site.
  let authorizedWithoutNativeGrant = tierPermitted;
  // A pane's per-tool grant is minted only by the user's "Allow for this
  // session", so beyond widening the floor it also stands in for the
  // confirmation that approval replaced (#12692). That second job is why a
  // pane consults it even for a tool its tier already permits — the
  // `worktree.deleteOwned` a user has allowed for the session.
  if ((!tierPermitted || paneApproval) && !relayWithheld) {
    const grant = sessionStore.grantCache.check(sessionId, actionId);
    if (grant.granted) {
      // Grant authorised the call. Capture the `issuedAt` token so the
      // post-dispatch refresh can verify the entry wasn't revoked and
      // re-issued under us (race guard, lesson #2243).
      grantIssuedAt = grant.issuedAt;
      authorizedWithoutNativeGrant = true;
    }
  }
  // A native automation grant does two jobs, and only the first is a floor
  // concern: it widens past the floor, AND it pre-authorises the
  // `danger: "confirm"` modal. The second is orthogonal to whatever admitted
  // the call, so the peek cannot be nested under any one admission source
  // (#11878). It used to sit inside the tier-denied branch, behind the
  // per-tool check — which left the grant unreachable both for a tool the
  // tier already permitted (`worktree.delete` is `danger: "confirm"` and sits
  // in core) and for one a per-tool grant had just
  // admitted.
  // Either way the modal still fired on every call despite an explicit
  // Settings pre-authorisation.
  //
  // The one exception: an introspection carrier is never confirm-gated, so
  // once the call is already admitted a grant buys it nothing — peeking
  // would only spend a use and evict entries on a discovery call. When the
  // call is NOT otherwise admitted the peek still runs, because there the
  // grant is doing its first job and is load-bearing for authorization.
  if (!relayWithheld && (!authorizedWithoutNativeGrant || !INTROSPECTION_TOOL_IDS.has(actionId))) {
    // The use is NOT charged here: it is consumed only once the call is
    // committed to dispatching (below), so an unauthorized call can't burn
    // a use. The grant's allowlist gates which tools this authorizes.
    const native = sessionStore.grantCache.peekNativeGrant(sessionId, actionId);
    if (native.granted) {
      nativeGrantId = native.grantId;
    }
  }
  // A pane call above its tier asks the user instead of being refused
  // (#12692) — so long as it is within what a pane can ever ask for. The ask
  // happens inside the dispatch below, after every hard refusal has had its
  // say, and a decline never reaches the denial accounting here: the agent
  // asked through the front door, which is not a probe.
  const approvalRequired =
    !authorizedWithoutNativeGrant &&
    nativeGrantId === undefined &&
    isApprovalRequestable(tier, actionId, paneApproval);
  if (!authorizedWithoutNativeGrant && nativeGrantId === undefined && !approvalRequired) {
    // Increment first, then ask the cache whether to suppress. The
    // post-increment count reflects "this denial counted"; the cache's
    // threshold compares against that. With threshold=2 the 1st and
    // 2nd denials fire the banner and the 3rd+ are suppressed.
    sessionStore.grantCache.incrementDenial(sessionId, actionId);
    const suppressBanner = sessionStore.grantCache.shouldSuppressBanner(sessionId, actionId);
    try {
      appendAuditRecord({
        toolId: actionId,
        sessionId,
        tier,
        args,
        durationMs: Date.now() - startedAt,
        startedAt,
        outcome: { kind: "unauthorized" },
        bannerSuppressed: suppressBanner ? true : undefined,
        capturedTurnId,
        rendererOwnedOrigin,
      });
    } catch (err) {
      console.error("[MCP] Failed to append audit record:", err);
    }
    if (notifyTierMismatch && !suppressBanner) {
      try {
        notifyTierMismatch({
          sessionId,
          toolId: actionId,
          tier,
          targetTier: minimumPermittingTier(actionId, rendererOwnedOrigin),
        });
      } catch (err) {
        console.error("[MCP] Failed to notify tier-mismatch:", err);
      }
    }
    if (recordDenial) {
      const result = recordDenial(sessionId, "tierMismatch");
      if (result.tripped) {
        const pinnedId = sessionStore.sessionWebContentsMap.get(sessionId);
        // Snapshot ownership with the pin, before revocation clears both.
        const rendererOwned = sessionStore.isRendererOwnedOrigin(sessionId);
        sessionStore.revokeSession(sessionId);
        clearDenialState?.(sessionId);
        if (notifySessionRevoked) {
          try {
            notifySessionRevoked({
              sessionId,
              denialKind: "tierMismatch",
              pinnedWebContentsId: pinnedId,
              rendererOwned,
            });
          } catch (err) {
            console.error("[MCP] Failed to notify session-revoked:", err);
          }
        }
      }
    }
    // A tool the tier admits but the origin does not would otherwise be
    // refused "for the 'full' tier" while the session holds exactly that
    // tier — true of the gate, and useless to a caller deciding what to do
    // next (#12407). An unscoped tool with an owned twin names the twin,
    // which is the call that would have worked.
    const withheldByOrigin =
      !rendererOwnedOrigin && tier !== "external" && isTierPermitted(tier, actionId, true);
    const ownedTwin = withheldByOrigin
      ? (OWNED_TWIN_TOOLS as Readonly<Record<string, string>>)[actionId]
      : undefined;
    // A relayed caller is another machine's own assistant, so "reserved for
    // Daintree's own assistant" would tell it it is something it isn't (#13493).
    const relayed = sessionSurface.relay === true;
    return {
      kind: "return",
      result: buildToolError({
        code: TIER_NOT_PERMITTED_CODE,
        message:
          ownedTwin !== undefined
            ? relayed
              ? `action '${actionId}' can reach any terminal or worktree on this host, so another machine's assistant uses '${ownedTwin}' here, which acts on what its calls created or started.`
              : `action '${actionId}' can reach any terminal or worktree, so it is reserved for Daintree's own assistant. Use '${ownedTwin}', which acts on what this connection created.`
            : withheldByOrigin
              ? relayed
                ? `action '${actionId}' can reach any terminal on this host, so another machine's assistant may only act on terminals its calls created or started here.`
                : `action '${actionId}' can reach any terminal, so it is reserved for Daintree's own assistant. This connection may only act on terminals it created.`
              : `action '${actionId}' is not permitted for the '${tier}' tier.`,
      }),
    };
  }

  return {
    kind: "continue",
    value: {
      paneApproval,
      grantIssuedAt,
      nativeGrantId,
      authorizedWithoutNativeGrant,
      approvalRequired,
    },
  };
}

/**
 * The confirm ceiling of a workspace-bound external session (#11789), once the
 * bound view's manifest is in hand: the refusal for a call that would raise a
 * dialog nobody is watching, or `undefined`. Narrows the introspection surface
 * by the same ceiling on the way, so a grant can never make a withheld tool
 * findable.
 */
export function refuseConfirmGatedBoundCall(
  facts: CallFacts,
  workspaceBinding: SessionServerDeps["workspaceBinding"],
  sessionSurface: Readonly<SessionSurfacePolicy>,
  boundManifest: import("../../../shared/types/actions.js").ActionManifestEntry[],
  viewlessStatusWorkspaceId: string | undefined,
  introspectionSurface: CallIntrospectionSurface | null,
  appendAuditRecord: CallAuditWriter
): CallToolResult | undefined {
  const { sessionId, actionId, args, tier, startedAt, capturedTurnId } = facts;
  const withheldIds = new Set(
    boundManifest
      .filter((entry) => isWithheldFromBoundSession(entry, tier, sessionSurface))
      .map((entry) => entry.id)
  );

  // Discovery must mirror dispatch authority (#11525): narrow the
  // introspection surface by the same ceiling, after the grant union, so a
  // grant can never make a withheld tool findable.
  if (introspectionSurface) {
    for (const withheldId of withheldIds) {
      introspectionSurface.permittedActionIds.delete(withheldId);
    }
  }

  // Which launch argument elevated a `terminal.new` dispatch, in the
  // resolver's own precedence — a command is the stronger claim, so it wins
  // when both are present. Scoped by action id for the reason the resolver
  // is: `command` is an ordinary field name that other safe actions take
  // without running anything.
  const terminalLaunchArg =
    actionId === TERMINAL_LAUNCH_ACTION_ID
      ? readDispatchTerminalCommand(args) !== undefined
        ? "command"
        : readDispatchTerminalCwd(args) !== undefined
          ? "cwd"
          : undefined
      : undefined;

  // A dispatch can need confirmation for any of three reasons, and none of
  // them is satisfiable here. The first is the manifest's own `danger:
  // "confirm"`, collected into `withheldIds` above. The other two are
  // args-conditional: the host elevates any agent-sourced dispatch carrying
  // a `recipeId` to `"confirm"` (#11860), so a statically-`safe` composite
  // like `worktree.createWithRecipe` clears the withheld set, and it
  // elevates a `terminal.new` carrying `command` or `cwd` for the same
  // reason (#12216) — both would then raise the very dialog this guard
  // exists to avoid. Read through the same extraction points the elevation
  // uses, so the refusal and the elevation can never disagree about which
  // dispatches are gated.
  const boundConfirmRefusal =
    viewlessStatusWorkspaceId !== undefined
      ? // The fallback runs in main and dispatches nothing, so none of the
        // three reasons below can apply to it: there is no renderer call to
        // elevate and no dialog to raise. Skipped explicitly rather than left
        // to fall through the empty stand-in manifest, which would still let
        // an args-conditional elevation refuse a read (#12316).
        undefined
      : withheldIds.has(actionId)
        ? `Action '${actionId}' requires confirmation, and this MCP session is bound to workspace ` +
          `'${workspaceBinding?.workspaceId}', which runs in the background with no one ` +
          `watching it to approve the dialog. The action was not run. Confirm-gated actions are not part ` +
          `of a workspace-bound session's tool surface — run this one from Daintree, or connect without a ` +
          `workspace binding.`
        : dispatchCarriesRecipeId(args)
          ? `Action '${actionId}' was called with a 'recipeId', so it would start that recipe's ` +
            `terminals and requires confirmation. This MCP session is bound to workspace ` +
            `'${workspaceBinding?.workspaceId}', which runs in the background with no one watching it ` +
            `to approve the dialog. The action was not run — call it without a 'recipeId', run the ` +
            `recipe from Daintree, or connect without a workspace binding.`
          : terminalLaunchArg !== undefined
            ? `Action '${actionId}' was called with a '${terminalLaunchArg}', so it would start a shell and ` +
              `requires confirmation. This MCP session is bound to workspace ` +
              `'${workspaceBinding?.workspaceId}', which runs in the background with no one watching it ` +
              `to approve the dialog. The action was not run — call it without 'command' or 'cwd', open ` +
              `the terminal from Daintree, or connect without a workspace binding.`
            : undefined;

  if (boundConfirmRefusal !== undefined) {
    const message = boundConfirmRefusal;
    const value: import("../../../shared/types/actions.js").ActionDispatchResult = {
      ok: false,
      error: {
        code: CONFIRMATION_REQUIRED_CODE,
        message,
        // Distinct from the `"unavailable"` a windowless host reports: that
        // one clears when a window opens, so retrying is sane. This one is
        // structural for the life of the session, so retrying never is.
        details: { confirmationChannel: "workspace-bound" },
      },
    };
    try {
      appendAuditRecord({
        toolId: actionId,
        sessionId,
        tier,
        args,
        durationMs: Date.now() - startedAt,
        startedAt,
        outcome: { kind: "result", value },
        capturedTurnId,
      });
    } catch (err) {
      console.error("[MCP] Failed to append audit record:", err);
    }
    return buildToolError({
      code: CONFIRMATION_REQUIRED_CODE,
      message,
      details: { confirmationChannel: "workspace-bound" },
    });
  }
  return undefined;
}

export function refuseCallerOnlyTool(
  facts: CallFacts,
  callers: CallerAdmission,
  appendAuditRecord: CallAuditWriter
): CallToolResult | undefined {
  const { sessionId, actionId, args, tier, startedAt, capturedTurnId, rendererOwnedOrigin } = facts;
  const { commandRunnerCaller, assistantControlCaller } = callers;
  // Refused here, past the tier gate but before a grant's use is spent or a
  // pane asks: a grant or a pane approval admits a call, and this one admits
  // only its own caller.
  if (
    (actionId === PROJECT_RUN_COMMAND_TOOL && !commandRunnerCaller) ||
    (ASSISTANT_CONTROL_TOOL_IDS.has(actionId) && !assistantControlCaller)
  ) {
    try {
      appendAuditRecord({
        toolId: actionId,
        sessionId,
        tier,
        args,
        durationMs: Date.now() - startedAt,
        startedAt,
        outcome: { kind: "unauthorized" },
        capturedTurnId,
        rendererOwnedOrigin,
      });
    } catch (err) {
      console.error("[MCP] Failed to append audit record:", err);
    }
    return buildToolError({
      code: TIER_NOT_PERMITTED_CODE,
      message:
        actionId === PROJECT_RUN_COMMAND_TOOL
          ? PROJECT_RUN_COMMAND_REFUSAL
          : ASSISTANT_CONTROL_REFUSAL,
    });
  }
  return undefined;
}

/** Spend the native grant's use for a call committed to proceeding (#10648): the grant still standing, or the refusal. */
export function chargeNativeGrant(
  grantCache: GrantCache,
  facts: CallFacts,
  admittedNativeGrantId: string | undefined,
  authorizedWithoutNativeGrant: boolean
): CallGate<string | undefined> {
  const { actionId, tier } = facts;
  let nativeGrantId = admittedNativeGrantId;
  // Charge the native automation grant's use now that the call has cleared
  // the tier/grant check and is committed to proceeding (#10648). Doing it
  // here — not at the peek above — means an unauthorized call never burns a
  // use. A `false` return is purely defensive: the grant was live at the
  // peek, so it can only have aged out or been revoked in between.
  //
  // How that failure lands depends on what else admitted the call (#11878).
  // When the grant WAS the authorization, losing it fails closed. When the
  // floor or a per-tool grant already admitted it, the grant only bought a
  // confirmation bypass — so drop the bypass and let the normal modal
  // decide. Refusing there would answer a tier-permitted `worktree.delete`
  // with "not permitted for the 'core' tier", which is simply untrue.
  //
  // Accounting note: a matching call spends a use even when the tool is not
  // confirm-gated, so the grant buys it nothing. Charging only where the
  // bypass is actually needed would mean resolving effective danger — the
  // async manifest plus args-conditional elevation — before this point,
  // which is a far larger change than the bug warrants. Two consequences
  // are worth knowing rather than assuming away: a matching call also
  // slides the whole grant's TTL, so a harmless tool in a mixed grant can
  // extend a confirm-gated sibling's bypass window (bounded by the hard
  // lifetime ceiling), and because this site precedes dedup, a replayed
  // duplicate spends a use without dispatching.
  //
  // One use is also the ONLY cost this site can express, which is why a tool
  // that fans out across every target it resolves at dispatch time is barred
  // from native grants entirely rather than charged here (#12121). Learning
  // that count would mean reaching into the renderer before the charge — the
  // async dependency the paragraph above rules out — so `peekNativeGrant`
  // never hands one back a grant id and `nativeGrantId` stays undefined:
  // no bypass, no use, and the confirm modal decides as it normally would.
  if (nativeGrantId !== undefined) {
    const consumed = grantCache.consumeNativeGrantUse(nativeGrantId, actionId);
    if (!consumed) {
      if (!authorizedWithoutNativeGrant) {
        return {
          kind: "return",
          result: buildToolError({
            code: TIER_NOT_PERMITTED_CODE,
            message: `action '${actionId}' is not permitted for the '${tier}' tier.`,
          }),
        };
      }
      nativeGrantId = undefined;
    }
  }
  return { kind: "continue", value: nativeGrantId };
}

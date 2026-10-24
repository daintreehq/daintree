import { ASSISTANT_CLOSE_CONFIRM_AGENT_STATES } from "../../../shared/types/agent.js";
import type { DispatchEnvelope } from "./shared.js";
import { MCP_SSE_IDLE_TIMEOUT_MS, RESOURCE_NOT_OWNED_CODE } from "./shared.js";
import { parseLastMessageReadArgs, type LastMessageReadArgs } from "./lastMessageArgs.js";
import {
  extractOwnedResourcesFromDispatch,
  type OwnedResourceKind,
  type OwnedResourceRecord,
} from "./resourceOwnership.js";
import type { TerminalAdoptionRecord } from "./terminalAdoption.js";
import type { OwnedMainExecutors, SessionServerDeps } from "./sessionServerDepsContract.js";
import { isHandedBackUntouched } from "./sessionServerDepsContract.js";
import { TERMINAL_READ_LAST_MESSAGE_OWNED_TOOL } from "./sessionToolIds.js";
import type { SessionStore } from "./sessionStore.js";

/**
 * Appended to a pane's refusal from a tool that takes a hand-over (#12980), so
 * the agent can tell the user what to click. Fixed text: it must not vary with
 * the refused id — see RESOURCE_NOT_OWNED_CODE.
 */
export const HAND_OVER_HINT =
  "If the user started that terminal, they can right-click it, choose 'Hand to orchestrator', " +
  "and select this agent's pane.";
export const HAND_OVER_GRANT_PATH = "context-menu:hand-to-orchestrator";

/**
 * Told to a caller no pane or help bearer bound (#12987) — an api-key client —
 * on an ownership refusal and alongside what it creates, since its records die
 * with its MCP session and nothing else would say so. Fixed text, for the same
 * reason as {@link HAND_OVER_HINT}.
 */
export const SESSION_OWNERSHIP_NOTE =
  "This credential only owns what it creates in the current MCP session: a new session does not " +
  `inherit it, and ${MCP_SSE_IDLE_TIMEOUT_MS / 60_000} minutes without MCP calls ends one. To keep ` +
  "ownership across reconnects, turn on Agent integrations for the project and launch the " +
  "orchestrator from Daintree; its credential owns what it creates until that pane exits or is " +
  "relaunched.";

export type OwnedResourceTool = {
  // `resourceKind`, not `kind`: this repo uses a bare `kind` for panel kinds
  // and guards comparisons against it with a lint rule, and an ownership
  // resource kind is a different taxonomy that would otherwise trip it.
  resourceKind: OwnedResourceKind;
  idArg: string;
  releasesOwnership: boolean;
  /**
   * Whether a terminal the user handed to this pane (#12490) is enough, or
   * only one the pane created will do. Declared on every entry rather than
   * derived from `releasesOwnership`, so a new tool has to decide it: the
   * cleanup tools say no, because handing over a conversation is not handing
   * over the right to destroy it.
   */
  acceptsAdoption: boolean;
} & (
  | {
      executor: "renderer";
      delegateTo: string;
      /**
       * The delegate's own name for the id, where it differs from the public one.
       * Arguments are rebuilt rather than forwarded, so without this the id
       * simply would not reach an action that spells it differently.
       */
      delegateIdArg?: string;
      /**
       * Arguments beyond the id that reach the delegate, copied by name (#12407).
       * Everything else the caller sent is dropped, and the checked id is written
       * after these so no forwarded field can name a different target.
       */
      forwardArgs?: readonly string[];
      /**
       * Whether this tool's job is to bring the user to the resource. Only a
       * reveal sets it, and only a reveal may: it is the single place on the
       * external surface that deliberately moves the user, so it alone routes
       * through the active view and raises that view's window.
       */
      reveals?: boolean;
    }
  | {
      executor: "main";
      handler: keyof OwnedMainExecutors;
      /**
       * The arguments beyond the id that reach the executor, validated and
       * copied by name (#12496). Nothing else checks them — a main-executed call
       * never passes through the action's schema parse — so a refusal here is a
       * validation error returned before anything is read.
       */
      readOptions: (args: unknown) => LastMessageReadArgs;
    }
);

export type RendererOwnedResourceTool = Extract<OwnedResourceTool, { executor: "renderer" }>;

/**
 * The session-scoped `*Owned` tools (#11909), and what each one runs once
 * ownership checks out.
 *
 * They run here rather than as ordinary renderer actions because the thing they
 * authorize against — which session created which resource — is main-process
 * state keyed by the MCP transport session id. The renderer never sees that id
 * and must not: handing it over would make "am I allowed to act on this?" a
 * question the caller's own dispatch could answer about itself.
 *
 * Delegation, not reimplementation. The check happens here; the close, the
 * delete and the reveal are the shipped actions, dispatched under their own ids
 * so `terminal.close`'s trash/recovery behaviour, `worktree.delete`'s D2
 * confirmation with its real file-count preview (`resolveMcpConfirmPreviewTarget`
 * in `useMcpBridge`, which matches on the literal action id) and
 * `pilot.openRun`'s switch-then-focus-intent sequence all apply unchanged.
 *
 * `releasesOwnership` splits the two things an owned tool can be. Cleanup ends
 * the resource, so the record goes with it; a reveal only navigates to one that
 * is still running, and dropping the record there would cost the session the
 * authority to reveal it a second time — or to clean it up at all.
 */
export const OWNED_RESOURCE_TOOLS: Record<string, OwnedResourceTool> = {
  "terminal.closeOwned": {
    resourceKind: "terminal",
    executor: "renderer",
    delegateTo: "terminal.close",
    idArg: "terminalId",
    releasesOwnership: true,
    acceptsAdoption: false,
  },
  // Moves a pane this session launched to another preset of its agent
  // (#14369). The pane survives, so the record stays; but the conversation
  // ends as surely as on a close, so a handed-over pane is refused like one.
  // Only the preset is forwarded: `confirmed` never is, so the approval is the
  // host's and the model cannot supply its own.
  "terminal.restartOnPresetOwned": {
    resourceKind: "terminal",
    executor: "renderer",
    delegateTo: "terminal.restartOnPreset",
    idArg: "terminalId",
    forwardArgs: ["presetId"],
    releasesOwnership: false,
    acceptsAdoption: false,
  },
  "worktree.deleteOwned": {
    resourceKind: "worktree",
    executor: "renderer",
    delegateTo: "worktree.delete",
    idArg: "worktreeId",
    releasesOwnership: true,
    acceptsAdoption: false,
  },
  // The panel is still the session's after it has been revealed, so this is the
  // one entry that keeps its record. `pilot.openRun` spells the id `runId`, and
  // the workspace it should travel to is supplied from the ledger rather than
  // left to default: the reveal runs in the view the user is looking at, which
  // is rarely the one holding the panel (#12315).
  "terminal.revealOwned": {
    resourceKind: "terminal",
    executor: "renderer",
    delegateTo: "pilot.openRun",
    idArg: "terminalId",
    delegateIdArg: "runId",
    releasesOwnership: false,
    acceptsAdoption: true,
    reveals: true,
  },
  // Where an owned panel sits, without moving the user (#13662). It delegates
  // to itself: the renderer definition is the focus-free placement, and the
  // generic placements it would otherwise wrap open the dock popover or take
  // focus. Only the destination is forwarded. Placing is not a claim the panel
  // stopped existing, so the record stays.
  "terminal.placeOwned": {
    resourceKind: "terminal",
    executor: "renderer",
    delegateTo: "terminal.placeOwned",
    idArg: "terminalId",
    forwardArgs: ["location"],
    releasesOwnership: false,
    acceptsAdoption: true,
  },
  // Keeps its record for the same reason the reveal above does: interrupting a
  // turn is not a claim the panel stopped existing, and dropping the record
  // would cost the session the authority to interrupt it again — or to close it
  // afterwards, which is the whole point of having a non-destructive stop
  // (#12338). Nothing beyond the id is forwarded, which is what keeps this from
  // becoming the general signal-passing surface it was deliberately not.
  "terminal.interruptOwned": {
    resourceKind: "terminal",
    executor: "renderer",
    delegateTo: "terminal.interrupt",
    idArg: "terminalId",
    releasesOwnership: false,
    acceptsAdoption: true,
  },
  // Terminal input, scoped to panels this session created (#12407). Neither
  // keeps nor drops anything beyond the record an interrupt keeps: submitting to
  // a panel is not a claim it stopped existing. The submission is the one entry
  // that forwards more than the id — its text, and whether to ask for a
  // handback (#12488) — while the injection forwards nothing, because the
  // context it writes is the active worktree's and never the caller's.
  "terminal.sendCommandOwned": {
    resourceKind: "terminal",
    executor: "renderer",
    delegateTo: "terminal.sendCommand",
    idArg: "terminalId",
    forwardArgs: ["command", "handback"],
    releasesOwnership: false,
    acceptsAdoption: true,
  },
  "terminal.injectOwned": {
    resourceKind: "terminal",
    executor: "renderer",
    delegateTo: "terminal.inject",
    idArg: "terminalId",
    releasesOwnership: false,
    acceptsAdoption: true,
  },
  // Keys for a dialog in a panel this session launched — most often the trust
  // screen a fresh worktree puts in front of an agent it just started. Only
  // the key list is forwarded; the delegate validates it.
  "terminal.sendKeysOwned": {
    resourceKind: "terminal",
    executor: "renderer",
    delegateTo: "terminal.sendKeys",
    idArg: "terminalId",
    forwardArgs: ["choose", "keys"],
    releasesOwnership: false,
    acceptsAdoption: true,
  },
  // The one entry that runs in main rather than delegating (#12479). What it
  // reads is a file the agent wrote, which the renderer cannot open, and the
  // answer is built from host state — the pty-host record and the store the
  // pane was spawned against — rather than anything the caller supplies.
  // Reading is not a claim the panel stopped existing, so the record stays.
  [TERMINAL_READ_LAST_MESSAGE_OWNED_TOOL]: {
    resourceKind: "terminal",
    executor: "main",
    handler: "handleTerminalReadLastMessageOwned",
    readOptions: parseLastMessageReadArgs,
    idArg: "terminalId",
    releasesOwnership: false,
    acceptsAdoption: true,
  },
};

/** The listing whose `owned` filter main resolves against the ledger (#12308). */
const TERMINAL_LIST_TOOL = "terminal.list";

/**
 * Split a `terminal.list` call's `owned` flag off the arguments the renderer
 * receives (#12308).
 *
 * The strip and the renderer's refusal are one mechanism rather than two
 * independent safeguards. Ownership is main-process state keyed by the MCP
 * session id, which the renderer never sees, so `terminal.list`'s `run()`
 * throws on any `owned` that reaches it — forwarding the flag would fail every
 * legitimate call. Dropping it without setting `ownedOnly` would do the
 * opposite and answer a narrowing question with the whole list. Reading both
 * out of one destructure is what stops those two halves drifting apart.
 *
 * Only an actual boolean is consumed. Anything else is left in place for the
 * renderer's own schema validation to reject, so a bad value comes back as the
 * validation error it is instead of being laundered into a legal request —
 * the same restraint `readSearchLimit` applies to an out-of-contract `limit`.
 */
export function prepareTerminalListDispatch(
  actionId: string,
  args: unknown
): { dispatchArgs: unknown; ownedOnly: boolean } {
  if (
    actionId !== TERMINAL_LIST_TOOL ||
    args === null ||
    typeof args !== "object" ||
    Array.isArray(args)
  ) {
    return { dispatchArgs: args, ownedOnly: false };
  }
  const { owned, ...rest } = args as Record<string, unknown>;
  if (typeof owned !== "boolean") return { dispatchArgs: args, ownedOnly: false };
  return { dispatchArgs: rest, ownedOnly: owned };
}

/**
 * Intersect a `terminal.list` result with what this session created (#12308).
 *
 * The payload is rebuilt from the renderer's rows rather than spread, so no
 * field this function did not understand rides along.
 *
 * An unreadable payload fails the call rather than emptying it, which is where
 * this parts company with `filterIntrospectionResultForSession`: there an
 * empty list IS the denial, while here it is a substantive answer — "you
 * created none of these" is what a client acts on when it decides it has
 * nothing to clean up. Reporting that from a listing nothing could read would
 * be the wrong answer rather than a cautious one.
 *
 * Rows are kept, never manufactured: a ledger record with no matching row in
 * the listing yields nothing, because the listing is what says which panels
 * exist and the ledger only says who created them.
 */
export function filterTerminalListToOwned(
  result: import("../../../shared/types/actions.js").ActionDispatchResult,
  owns: (terminalId: string) => boolean
): import("../../../shared/types/actions.js").ActionDispatchResult {
  if (!result.ok) return result;
  const payload = result.result as { terminals?: unknown; panelLimit?: unknown } | null | undefined;
  if (!Array.isArray(payload?.terminals)) {
    return {
      ok: false,
      error: {
        code: "RESULT_VALIDATION_ERROR",
        message:
          "terminal.list returned a listing that could not be intersected with this session's ownership records.",
      },
    };
  }
  return {
    ok: true,
    result: {
      // Rebuilt rather than spread so a field added to the listing later is
      // reviewed here, not passed through unfiltered.
      terminals: payload.terminals.filter((row) => {
        const id = (row as { id?: unknown } | null | undefined)?.id;
        return typeof id === "string" && owns(id);
      }),
      // The project-wide count the hard limit is judged on, never narrowed to
      // this caller's own rows.
      panelLimit: payload.panelLimit,
    },
  };
}

/**
 * Whether a `terminal.close` result reports the named panel as actually closed.
 *
 * Structural rather than trusting the action id: an empty `closedIds` is
 * `terminal.close`'s documented "nothing closed" answer, and the ownership
 * release must be able to tell that apart from a real close.
 */
function closedIdsInclude(result: unknown, id: string): boolean {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const closedIds = (result as { closedIds?: unknown }).closedIds;
  return Array.isArray(closedIds) && closedIds.includes(id);
}

/**
 * The resource id an `*Owned` call names, or `undefined` when the
 * argument is missing, the wrong type, or blank.
 *
 * Read here rather than trusting the renderer's schema validation, because the
 * ownership check runs before the dispatch that would perform it — and a
 * whitespace-only id must not reach a Map lookup that could only ever miss.
 */
export function readOwnedResourceId(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  // Blankness is judged on the trimmed form, but the ORIGINAL is returned: the
  // ledger stores ids exactly as the creating action reported them, and
  // `agent.launch`'s `requestedId` lets a caller create one with surrounding
  // whitespace. Handing the trimmed form to the lookup would make that
  // resource permanently uncleanable.
  return value.trim().length === 0 ? undefined : value;
}

/** The ownership questions one call asks, under the owner and workspace it was admitted with. */
export interface OwnershipAccess {
  readonly ownedRecordFor: (
    kind: OwnedResourceKind,
    resourceId: string
  ) => OwnedResourceRecord | undefined;
  readonly adoptedRecordFor: (
    resourceKind: OwnedResourceKind,
    resourceId: string
  ) => OwnedResourceRecord | undefined;
  readonly drivesTerminal: (terminalId: string) => boolean;
  readonly closeNeedsApproval: (terminalId: string) => Promise<boolean>;
}

export function createOwnershipAccess(
  sessionStore: Pick<SessionStore, "resourceOwnership" | "terminalAdoption">,
  ownershipOwner: string,
  boundWorkspaceId: string | undefined,
  readTerminalCloseContext: SessionServerDeps["readTerminalCloseContext"]
): OwnershipAccess {
  /**
   * The record that gives this call authority over a resource it created,
   * or `undefined`. Shared by the `*Owned` gate and an `owned` listing, so
   * the listing reports exactly the terminals those tools accept (#12487) —
   * together with {@link adoptedRecordFor} for the tools that also take a
   * hand-over.
   *
   * The bound-workspace comparison is defence-in-depth only and fails OPEN
   * when either side is unknown: panel ids carry a UUID and worktree ids are
   * absolute paths, so a cross-workspace collision is not a live risk, and a
   * strict check would strand a caller's own cleanup whenever the creating
   * dispatch could not resolve its workspace.
   */
  const ownedRecordFor = (
    kind: OwnedResourceKind,
    resourceId: string
  ): OwnedResourceRecord | undefined => {
    const record = sessionStore.resourceOwnership.get(ownershipOwner, kind, resourceId);
    if (record === undefined) return undefined;
    const workspaceMismatch =
      record.workspaceId !== undefined &&
      boundWorkspaceId !== undefined &&
      record.workspaceId !== boundWorkspaceId;
    return workspaceMismatch ? undefined : record;
  };
  /**
   * The record a user's hand-over gives this call over a terminal it did not
   * create (#12490), shaped like an ownership record so the gate and a
   * reveal read one type. Matched on the same owner the ledger reads, which
   * is a bearer principal for a pane session and never anything an api-key
   * client can be. The workspace comparison fails open exactly as
   * {@link ownedRecordFor}'s does.
   */
  const adoptedRecordFor = (
    resourceKind: OwnedResourceKind,
    resourceId: string
  ): OwnedResourceRecord | undefined => {
    if (resourceKind !== "terminal") return undefined;
    const adoption = sessionStore.terminalAdoption.get(ownershipOwner, resourceId);
    if (adoption === undefined) return undefined;
    if (
      adoption.workspaceId !== undefined &&
      boundWorkspaceId !== undefined &&
      adoption.workspaceId !== boundWorkspaceId
    ) {
      return undefined;
    }
    return {
      kind: resourceKind,
      id: resourceId,
      ...(adoption.workspaceId !== undefined ? { workspaceId: adoption.workspaceId } : {}),
    };
  };
  /**
   * Whether this call may drive a terminal: one it created, or one the user
   * handed it. What an `owned` listing reports, because that listing is how
   * an orchestrator finds the terminals it was given.
   */
  const drivesTerminal = (terminalId: string): boolean =>
    ownedRecordFor("terminal", terminalId) !== undefined ||
    adoptedRecordFor("terminal", terminalId) !== undefined;
  /**
   * Whether Daintree's own assistant must ask before closing this panel
   * (#12881): this session did not create it, or its agent was last seen
   * working or waiting. #12407 kept the unscoped close so the assistant can
   * tidy up what it launched; closing what the user opened, or an agent
   * still mid-task, is a different authority and needs the user.
   *
   * A hand-over does not count as creation: it lends the right to drive an
   * agent, not to discard it. Anything unknown asks: no ownership record, or
   * an agent state that could not be read.
   *
   * One `waiting` agent is finished rather than mid-conversation (#13128):
   * it printed the handback this session asked for, and nothing has been
   * typed into it since. The pty-host drops the handback when a later prompt
   * is submitted, so one still present answers the latest submission.
   */
  const closeNeedsApproval = async (terminalId: string): Promise<boolean> => {
    if (ownedRecordFor("terminal", terminalId) === undefined) return true;
    if (readTerminalCloseContext === undefined) return true;
    try {
      const context = await readTerminalCloseContext(terminalId);
      const state = context?.agentState;
      if (context === null || state === undefined) return false;
      if (!ASSISTANT_CLOSE_CONFIRM_AGENT_STATES.has(state)) return false;
      return !(state === "waiting" && isHandedBackUntouched(context));
    } catch {
      return true;
    }
  };

  return { ownedRecordFor, adoptedRecordFor, drivesTerminal, closeNeedsApproval };
}

/** One call's stand-in for the action an `*Owned` tool delegates to, read when it runs. */
export interface OwnedDispatchCall {
  readonly sessionId: string;
  readonly actionId: string;
  readonly args: unknown;
  readonly sessionStore: Pick<
    SessionStore,
    "terminalAdoption" | "resourceOwnership" | "sessionWorkspaceMap"
  >;
  readonly ownershipOwner: string;
  readonly adoptedRecordFor: OwnershipAccess["adoptedRecordFor"];
  readonly admittedAdoption: TerminalAdoptionRecord | undefined;
  readonly dispatchToRenderer: (id: string, dispatchArgs: unknown) => Promise<DispatchEnvelope>;
  readonly dispatchConfirmed: boolean;
  readonly revealOwnedRun: SessionServerDeps["revealOwnedRun"];
}

/**
 * Dispatch the real action an `*Owned` tool stands in for, with arguments
 * rebuilt from scratch rather than forwarded (#11909).
 *
 * Rebuilding is the enforcement: the renderer validates against
 * `worktree.delete`'s schema, which still accepts `force`, `deleteBranch`
 * and `closeTerminals`, so anything the caller sent beyond the id would
 * otherwise pass straight through the narrower tool that deliberately omits
 * them. An entry that needs more than the id names each field in
 * `forwardArgs`; the values are left for the delegate's own schema to
 * validate. It is also what lets a delegate spell the id differently —
 * `pilot.openRun` takes `runId` where the public tool takes `terminalId`.
 *
 * A reveal differs in both of the ways that matter (#12315). It carries the
 * destination workspace, read from the ledger record main wrote when the
 * panel was created — trusted state, never the caller's argument, and the
 * only thing that says where an unbound session's panel actually lives. And
 * it routes through the active view rather than this session's own, because
 * the view that switches has to be the view on screen.
 */
export async function dispatchOwnedResource(
  call: OwnedDispatchCall,
  entry: RendererOwnedResourceTool,
  resourceId: string
): Promise<{ envelope: DispatchEnvelope; raised: boolean }> {
  const {
    sessionId,
    actionId,
    args,
    sessionStore,
    ownershipOwner,
    adoptedRecordFor,
    admittedAdoption,
    dispatchToRenderer,
    dispatchConfirmed,
    revealOwnedRun,
  } = call;
  if (
    admittedAdoption !== undefined &&
    sessionStore.terminalAdoption.get(ownershipOwner, resourceId) !== admittedAdoption
  ) {
    return {
      envelope: {
        result: {
          ok: false,
          error: {
            code: RESOURCE_NOT_OWNED_CODE,
            message:
              `The user took ${entry.resourceKind} '${resourceId}' back from this pane before ` +
              `'${actionId}' reached it, so nothing was sent.`,
          },
        },
      },
      raised: true,
    };
  }
  const delegateArgs: Record<string, unknown> = {};
  if (entry.forwardArgs !== undefined && args !== null && typeof args === "object") {
    const callerArgs = args as Record<string, unknown>;
    for (const key of entry.forwardArgs) {
      if (Object.hasOwn(callerArgs, key)) delegateArgs[key] = callerArgs[key];
    }
  }
  delegateArgs[entry.delegateIdArg ?? entry.idArg] = resourceId;
  if (entry.reveals !== true) {
    return {
      envelope: await dispatchToRenderer(entry.delegateTo, delegateArgs),
      raised: true,
    };
  }
  const revealWorkspaceId =
    (
      sessionStore.resourceOwnership.get(ownershipOwner, entry.resourceKind, resourceId) ??
      adoptedRecordFor(entry.resourceKind, resourceId)
    )?.workspaceId ?? sessionStore.sessionWorkspaceMap.get(sessionId);
  // Omitted rather than guessed when neither is known: `pilot.openRun`
  // falls back to the executing view's own workspace, which is where the
  // panel is if the client never left it — the only honest default here.
  if (revealWorkspaceId !== undefined) {
    delegateArgs.workspaceId = revealWorkspaceId;
  }
  if (revealOwnedRun === undefined) {
    return {
      envelope: await dispatchToRenderer(entry.delegateTo, delegateArgs),
      raised: true,
    };
  }
  return revealOwnedRun(revealWorkspaceId, entry.delegateTo, delegateArgs, dispatchConfirmed);
}

/**
 * Fold a completed dispatch into the session's ownership ledger (#11909):
 * record what it created, and release what it cleaned up.
 *
 * Both halves read the envelope the action returned — never the caller's
 * arguments — which is what makes the ledger an authorization boundary
 * rather than a claim the caller writes about itself.
 *
 * The release half is deliberately conditional on the resource actually
 * being gone. `terminal.close` reports an empty `closedIds` when it found
 * nothing to close, and dropping the record on that would let one no-op
 * call revoke the session's authority over a panel that is still running.
 * A non-releasing owned tool — a reveal — returns before any of that:
 * navigating to a panel is not a claim that it stopped existing (#12315).
 */
export function recordOwnershipFromDispatch(
  call: {
    readonly sessionId: string;
    readonly actionId: string;
    readonly sessionStore: Pick<
      SessionStore,
      "resourceOwnership" | "terminalAdoption" | "workerCreations" | "hasLiveTransport"
    >;
    readonly ownershipOwner: string;
  },
  owned: {
    readonly ownedResource: OwnedResourceTool | undefined;
    readonly ownedResourceId: string | undefined;
    readonly ownedResourceRecord: OwnedResourceRecord | undefined;
  },
  envelope: DispatchEnvelope
): void {
  const { sessionId, actionId, sessionStore, ownershipOwner } = call;
  const { ownedResource, ownedResourceId, ownedResourceRecord } = owned;
  if (ownedResource !== undefined) {
    if (!ownedResource.releasesOwnership) return;
    if (ownedResourceId === undefined || !envelope.result.ok) return;
    if (
      ownedResource.resourceKind === "terminal" &&
      !closedIdsInclude(envelope.result.result, ownedResourceId)
    ) {
      return;
    }
    sessionStore.resourceOwnership.release(
      ownershipOwner,
      ownedResource.resourceKind,
      ownedResourceId,
      ownedResourceRecord
    );
    return;
  }
  const drafts = extractOwnedResourcesFromDispatch(actionId, envelope.result);
  if (drafts.length === 0) return;
  // Liveness guard, mirroring the dedup completion hook below: a creation
  // admitted before the session was revoked can land after
  // `clearSessionBinding` already dropped the ledger. Writing then would
  // resurrect a dead session's authority — and, worse, claim the id away
  // from whoever legitimately records it next. A pane bearer's principal
  // outlives its sessions, so its creation still lands after a disconnect;
  // `record` itself refuses one whose bearer was revoked (#12487).
  if (
    !sessionStore.resourceOwnership.isPrincipalOwner(ownershipOwner) &&
    !sessionStore.hasLiveTransport(sessionId)
  ) {
    return;
  }
  const recorded = sessionStore.resourceOwnership.record(
    ownershipOwner,
    drafts,
    envelope.dispatchedWorkspace?.workspaceId
  );
  // A creation under an id that was handed over names a new terminal, and
  // the hand-over was of the old one (#12490). Left in place, the id would
  // have two drivers: its creator and the pane it was handed to. Every
  // recorded id is offered: only terminals are ever handed over, and a
  // worktree id is an absolute path no panel id can equal.
  for (const record of recorded) sessionStore.terminalAdoption.release(record.id);
  // What was created, by whom, kept past the authority itself (#14166):
  // from the trusted result, so a creation that landed after its creator's
  // revocation still says who made it, while recording no authority.
  sessionStore.workerCreations.noteDrafts(ownershipOwner, drafts);
}

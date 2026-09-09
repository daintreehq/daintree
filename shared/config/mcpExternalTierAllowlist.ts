import type { BuiltInActionId } from "../types/actions.js";
import { ACTIONS_LIST_TOOL } from "./helpAssistantTierAllowlists.js";

/**
 * The one and only tool surface reachable by an `external` (api-key) MCP
 * session, and the sole seam for widening it — each entry is a deliberate,
 * individually vetted addition. There is no opt-in that lifts this floor: a
 * `fullToolSurface` flag used to short-circuit both tier gates and trust the
 * author-set `danger` / `mcpVisibility` fields as the ceiling, which exposed 335
 * of 426 actions to any api-key caller (#10701). The MCP spec is explicit that
 * tool annotations are untrusted UX hints, not an access-control boundary; this
 * server-side allowlist is the enforceable one. The flag was never reachable
 * from the UI or IPC and was removed outright in #11537 rather than left
 * dormant.
 *
 * This list is simultaneously the *advertised* and the *callable* external
 * contract: `tools/list` shows exactly these, and `tools/call` accepts exactly
 * these. Nothing is withheld from the listing while staying dispatchable —
 * #11582 tried that and it does not work, because no shipped client sends
 * `tools/call` for a name it never received (Claude Code builds its registry
 * from `tools/list` and rejects unlisted names before they become requests).
 *
 * The size is a hard product constraint, not a style preference (#11585). At 100
 * entries / ~128 KB of schema this surface was past what clients tolerate:
 * Cursor caps the tool count across all connected servers and silently
 * truncates the overflow, and GitHub Copilot's 128-tool cap is a hard blocking
 * error. Either way we were losing tools without controlling *which*. Selection
 * rule: keep what only Daintree can do — terminal and agent orchestration,
 * worktrees, recipes, skills, live IDE context — and drop what the caller can
 * already do for itself. An external agent driving us over MCP sits in a
 * terminal with its own shell and its own `gh`, so git plumbing, forge
 * reads/writes, file reads and project queries are its job, not ours. All of
 * that remains fully available to the in-app assistant via the
 * workbench/action/system tiers in `helpAssistantTierAllowlists.ts`, which no
 * third-party client cap applies to.
 *
 * Budgeted in both dimensions, because the failure is measured in bytes as much
 * as in tools: the count ceiling lives in `tierAuth.test.ts` (against
 * `TIER_ALLOWLISTS.external`, the actual gate) and the summed description bytes
 * in `actionDefinitions.quality.test.ts` (where the live registry text is
 * reachable). 23 tools carrying novel-length descriptions would reproduce the
 * same truncation with a count that still looks fine.
 */
export const MCP_EXTERNAL_TIER_TOOLS = [
  ACTIONS_LIST_TOOL,
  "actions.getContext",
  "actions.search",
  "actions.getSchema",
  // Only Daintree can answer what its own surface currently is, and this caller
  // class needs it most: the external contract is the one that just shrank from
  // 100 tools to this list, and a third-party client written against the old
  // shape has no other way to find out (#11549).
  "mcp.surface",

  "agent.launch",
  // `agent.launch` accepts user- and plugin-contributed agent ids, and only
  // Daintree knows the authoritative effective registry and live launchability.
  // Not something the caller's shell can answer.
  "agent.listAvailable",
  // The same argument one step further in: launching also takes a preset id,
  // and those ids are generated rather than guessable. They come from user
  // settings, `.daintree/presets/` files and CCR discovery, merged with a
  // precedence only Daintree applies, so no shell command reconstructs the
  // list. Without it the preset argument is undiscoverable from out here — the
  // caller's only route today is reading an id off a panel already running one
  // (#11859). Identity only: no env, args or flags at any redaction level.
  "agent.listPresets",

  // The same argument as `agent.listPresets`, one surface out: workspace ids
  // are minted by Daintree and cannot be reconstructed from outside it.
  // `Daintree-Workspace-Id` has shipped since #11789 and routes a session to
  // one workspace deterministically, but nothing on this surface said what the
  // ids were, so external clients recovered them by hashing candidate paths —
  // the one lookup `projectStorePaths.ts` says is invalid, since a relocated
  // project keeps its original id and `mintProjectId`'s `randomBytes(32)`
  // collision fallback is not derivable at all. Without this the binding
  // mechanism is only usable by guessing its key (#12307). Identity only:
  // id, path, name, kind and whether a view is open — nothing about what is
  // running inside a workspace.
  "workspace.list",

  // Read-only fleet-run supervision snapshot (#10930). The broadcast itself is
  // deliberately NOT exposed — external orchestrators fan out
  // `terminal.sendCommand` per terminal (see CLAUDE.tasks.md guidance).
  "fleet.getRunStatus",

  "recipe.list",
  "recipe.run",

  // Plugin-contributed skills are Daintree-owned data with no shell equivalent,
  // and the external-tier contract is pinned by an E2E
  // (e2e/full/plugins/core-plugin-skills.spec.ts).
  "skills.search",
  "skills.load",

  "terminal.list",
  "terminal.getOutput",
  "terminal.getStatus",
  "terminal.sendCommand",
  "terminal.inject",
  "terminal.new",
  // The generic `terminal.close` is still deliberately NOT here, and the reason
  // it was excluded is the reason this entry exists. #11540's draft core set
  // included it on the argument that closing is recoverable, so an orchestrator
  // that opens terminals should be able to close them. That did not survive
  // contact with this caller class: `terminal.list` enumerates every panel in
  // the view — the user's own shells and other agents' terminals included — and
  // nothing bound a panel to the session that created it, so "close the ones it
  // opened" was not an invariant we had. Recovery is worse: trash is purged
  // after TRASH_TTL_MS (20s), which kills the PTY, and no restore action is on
  // this surface.
  //
  // #11909 supplied the missing invariant rather than relaxing the objection.
  // The MCP server now keeps a server-authoritative ledger of which session
  // created which panel, written only from trusted post-dispatch results, and
  // `terminal.closeOwned` acts on nothing else. The narrow tool is on the
  // surface; the general primitive is not, which is the whole distinction —
  // the same name at a wider tier would have given this caller a different
  // contract behind an identical id.
  "terminal.closeOwned",
  // The last direction in that loop with no route (#12315). A client can launch
  // an agent, inject into it, read it and dispose of it, and still has no way to
  // say "here it is" — so `gc attach`, whose entire purpose is putting the
  // operator in front of a session, returns exit 2 and tells the user the
  // session exists instead of taking them to it.
  //
  // Two shapes were rejected before this one, and both are worth stating,
  // because both look like reuse and neither is. A `focus` argument on an
  // existing tool would be the first exception to `useMcpBridge`'s unconditional
  // `focusPolicy: "preserve"` — written so a client cannot claim a focus policy
  // any more than it can claim to be the assistant. `panel.focus` here would
  // fail hardest in exactly the case it was wanted for: `rendererBridge`
  // resolves a bound workspace without attaching, thawing, activating, focusing
  // or switching anything, so aiming it at a workspace nobody is watching
  // selects a panel inside a cached view, moves DOM focus where it cannot be
  // seen, and returns success.
  //
  // What ships instead is the operation that already existed: main verifies the
  // panel against this session's ownership ledger, then delegates to
  // `pilot.openRun`, which switches the workspace and carries a one-shot focus
  // intent the incoming view applies once hydrated — and raises the owning
  // window afterwards, since a switch alone does nothing when Daintree is
  // behind another application.
  //
  // This is the one entry that deliberately disturbs what the user is looking
  // at, which is a decision about the contract rather than a spare slot: the
  // binding path exists precisely so a session driving project A cannot move
  // someone working in B. Ownership is what keeps that honest — a client can
  // only be taken to a panel it created, which is no escalation over having
  // created it — and the ledger is server-authoritative, written from trusted
  // dispatch results, so the id cannot be claimed into it.
  "terminal.revealOwned",
  // The step between waiting and destroying, which this surface did not have
  // (#12338). A client could launch an agent and watch it, and if the agent had
  // misread the task its only lever was `terminal.closeOwned` — which takes the
  // conversation with it, and on a long session the conversation is the
  // expensive part. Submitting text is not the missing lever either: an agent
  // mid-turn is not reading its prompt, so a submission queues behind exactly
  // the work it was meant to stop.
  //
  // What is on the surface is one operation meaning "stop this turn", not a
  // signal API. There is no caller-supplied signal, no key sequence argument
  // and no process handle: the id is the only thing that crosses, and Daintree
  // picks the mechanism. A signal would not have worked anyway — node-pty's
  // `kill()` reaches our wrapper shell, which carries `trap : INT` and swallows
  // it before the agent sees anything.
  //
  // It refuses more than it accepts, deliberately. An agent whose own CLI
  // advertises a different cancel key is named and refused rather than written
  // to, and one that is not mid-turn is refused rather than sent a stray
  // Escape. What it never does is report an interruption: the transport is
  // one-way, so the result says the keystrokes were handed over and stops
  // there.
  "terminal.interruptOwned",
  "terminal.waitUntilIdle",
  "terminal.waitUntilIdleBatch",
  // The one piece of state an orchestrator owns that Daintree had nowhere to
  // put (#12340). Panel lifetime is ours and the metadata about panels is the
  // client's, so the two drift by construction: every external orchestrator
  // kept a sidecar mapping panel ids to its own logical sessions, and that
  // sidecar dies with the client process, is invisible to every other client,
  // and silently keeps an entry for a panel the user has closed. Reconciling
  // after a reconnect is exactly the operation that needs it to be right.
  //
  // What earns the slot is that nothing else on this surface can carry it.
  // `requestedId` is write-once at creation and is an id, not a payload; the
  // title is a user-visible field `agent.launch` deliberately pins; `env`
  // writes into the agent's own process environment. The store itself is not
  // new — `extensionState` is opaque, capped and rides the layout save — so
  // this is one reserved key on a bag that already shipped, not a key-value
  // service. It is bounded at 2KB, invisible in the UI, deleted with the
  // panel, and confers nothing: metadata cannot put a panel in the ownership
  // ledger, so it buys no `closeOwned` or `revealOwned` authority (#12308).
  //
  // Namespaced, not scoped, and the read is deliberately shared. One external
  // API key means every client hashes to the same bearer entry, so there is no
  // durable client identity to isolate by — the same answer Kubernetes
  // annotations and Docker labels give. `terminal.list` carries the read
  // behind an opt-in flag, which is what keeps this to one slot.
  "terminal.setClientMetadata",

  "worktree.list",
  "worktree.getCurrent",
  "worktree.createWithRecipe",
  // The counterpart to `worktree.createWithRecipe`, and only that: it deletes a
  // worktree this session created and refuses everything else (#11909). The
  // generic `worktree.delete` stays cut — #11585 removed it as "D2 destructive,
  // and not needed to drive work forward", which is still true of an arbitrary
  // worktree and was never true of the caller's own leftovers.
  //
  // It keeps `danger: "confirm"`, so a human still approves the delete against
  // a real preview of the worktree's contents, and `isWithheldFromBoundSession`
  // withholds it entirely from a workspace-bound session whose view nobody is
  // watching — at discovery and at dispatch, from the manifest field alone.
  "worktree.deleteOwned",
  "worktree.setActive",

  // A deliberate product exception rather than a clean pass of the rule above,
  // so it is worth stating the reasoning plainly. A caller holding
  // `terminal.sendCommand` could pipe files through `pbcopy` itself, so this is
  // not a capability it categorically lacks. What it cannot reproduce is the
  // actual deliverable: one call that applies the project's own CopyTree policy
  // (ignore rules, budgets, format) and puts a FILE on the clipboard the same
  // way across macOS, Linux and Windows. The alternative is a brittle
  // shell-and-pipe reconstruction per platform. Without the entry the feature
  // only half exists — the in-app assistant reaches it through the system tier
  // while Claude Code and Codex, the callers #11722 names, cannot.
  //
  // Its blast radius is a clipboard overwrite, which `actionRiskBand` already
  // bands `destructive-local` and the tool advertises via `destructiveHint`.
  "copyTree.generateAndCopyFile",
] as const satisfies readonly BuiltInActionId[];

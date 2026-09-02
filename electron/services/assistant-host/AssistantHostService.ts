import { app, webContents, type WebContents } from "electron";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AssistantHostProcess } from "./AssistantHostProcess.js";
import { resolveAssistantBinary, ASSISTANT_BIN_ENV } from "./resolveAssistantBinary.js";
import { assistantPlatformSupport } from "../../../shared/config/assistantPlatform.js";
import { assistantChildEnv } from "./assistantChildEnv.js";
import { getHelpAssistantSettings } from "../../ipc/handlers/helpAssistant.js";
import { helpSessionService } from "../HelpSessionService.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AssistantTimerService } from "../assistant-timers/AssistantTimerService.js";
import {
  ASSISTANT_HOST_PROTOCOL_VERSION,
  type AssistantHostCommand,
  type AssistantHostEvent,
} from "../../../shared/types/ipc/assistantHost.js";
import { CHANNELS } from "../../ipc/channels.js";
import {
  DEFAULT_ASSISTANT_SLOT,
  assistantSlotKey,
  isValidAssistantSlot,
} from "../../../shared/config/assistantSlots.js";
import type { AssistantHostStartResult } from "../../../shared/types/ipc/assistantHostIpc.js";
import { createLogger } from "../../utils/logger.js";

/**
 * Owns the live assistant engine for each project, and routes its event stream to the
 * renderer that started it.
 *
 * Two invariants carried over from the PTY-backed assistant, both learned the hard way:
 *
 * 1. **Delivery is PINNED, never broadcast** (#7003). Every event goes to the exact
 *    `WebContents` that started the session. Daintree is multi-window and each project
 *    has its own renderer; a broadcast would put one project's conversation — and its
 *    approval prompts — on another project's screen.
 * 2. **One engine per LANE** (#7522, re-scoped by #12108). A lane is `(projectId,
 *    slot)`. Starting a session for a lane that already has one displaces the old one
 *    rather than running two, because two engines on one lane would both hold that
 *    lane's state lease and fight over it. Different lanes of the same project run
 *    side by side: each gets its own engine state namespace, so each takes its own
 *    `owner.lock` and none of them contends.
 */

export interface StartSessionOptions {
  projectId: string;
  /** Project root; the engine's working directory. */
  cwd: string;
  /**
   * Which parallel lane this session is (#12108). Defaults to
   * {@link DEFAULT_ASSISTANT_SLOT} so a caller that predates lanes still means the
   * one session a project used to have.
   */
  slot?: number;
  windowId: number;
  /** The renderer that owns this session. Events are pinned to it. */
  webContentsId: number;
}

interface LiveSession {
  sessionId: string;
  projectId: string;
  /** The lane this engine occupies. `(projectId, slot)` is its identity. */
  slot: number;
  host: AssistantHostProcess;
  /**
   * Every surface watching this session: WebContents id → its attachment.
   *
   * One project, one engine, many windows. Two engines is not an alternative — the
   * engine takes an exclusive lease on the project's state, so a sibling would queue
   * behind it and time out — and displacing was what shipped before, which silently
   * tore down whichever window had the conversation first.
   *
   * The window id rides along because a surface is lost in two different ways, at
   * different moments and by different code: a view is evicted or crashes, a window is
   * closed. A subscriber reachable by only one of those survives the other.
   */
  subscribers: Map<number, { windowId: number; attachmentId: string }>;
  /**
   * The surface whose view this engine's MCP bearer is pinned to.
   *
   * The pin is captured once, when the control plane hands out the session, and the MCP
   * layer deliberately never re-points it — a session that could flip to another
   * window's tool surface is the leak lessons #7003/#9887 exist to prevent. So tool
   * calls always act on THIS view, whichever window the prompt came from, and an engine
   * whose pinned view is gone can still talk but can no longer do anything.
   *
   * Rather than leave the other windows holding a half-dead assistant, the session ends
   * with this surface. They see an ordinary exit and can start it again — which is a
   * long way from the silent teardown this whole change replaced, and honest about a
   * limitation that only a per-attachment control plane can actually remove.
   */
  provisionerWebContentsId: number;
}

/**
 * Startup and engine diagnostics go to the main log, not bare `console`.
 *
 * The panel reports exactly one thing while an engine boots — "starting" — and this
 * path can sit there legitimately for up to `READY_TIMEOUT_MS`. Without a trace,
 * every way of failing to reach `host:ready` (no binary, a provision that hangs, a
 * child that spawned and said nothing, a protocol refusal) presents identically, and
 * the only evidence is a spinner. Each phase below is logged with the elapsed time, so
 * a stuck start names the phase it is stuck in.
 */
const logger = createLogger("main:AssistantHost");

/** A fresh id for one surface's attachment to a session. */
function newAttachmentId(): string {
  return `att_${randomBytes(6).toString("hex")}`;
}

/** The roster id the MCP tier policy is keyed on for this surface. */
const ASSISTANT_AGENT_ID = "daintree-assistant";

/**
 * The engine state namespace a lane runs in, as an env fragment.
 *
 * The namespace moves the engine's PER-PROJECT directory — its `state.db` and the
 * `owner.lock` guarding it — while deliberately leaving the state ROOT alone, where
 * `auth/` and the endpoint preference live. That distinction is the whole reason this
 * is the right lever for parallel sessions: every lane is the same signed-in account
 * talking to the same backend, with its own conversation and its own lease, rather
 * than a second installation that would demand a fresh `/login`.
 *
 * Two axes fold into one string:
 *
 * - An unpackaged build gets `dev`, so a dev build and the installed app open on the
 *   same project do not contend. (Packaged builds cannot: Electron's single-instance
 *   lock means two of them never run at once.)
 * - Lanes 1+ get an `s<N>` suffix. Slot 0 gets none, which is what keeps an existing
 *   install's conversation, memories, audit trail and automation grants exactly where
 *   they already are.
 *
 * Returns an EMPTY fragment for the packaged default lane so the variable stays unset
 * rather than set-to-empty — the engine reads a blank namespace as "no namespace"
 * either way, but leaving it out is the honest spelling and the one that shipped.
 */
function namespaceEnv(slot: number): Record<string, string> {
  const parts = [app.isPackaged ? "" : "dev", slot === DEFAULT_ASSISTANT_SLOT ? "" : `s${slot}`];
  const namespace = parts.filter(Boolean).join("-");
  return namespace ? { DAINTREE_ASSISTANT_STATE_NAMESPACE: namespace } : {};
}

/**
 * How often to say an engine is still short of `host:ready`.
 *
 * The readiness budget is 90s, which is a long time to show nothing. This is the
 * heartbeat that distinguishes "still waiting" from "the host stopped waiting and
 * nobody said so".
 */
const READY_PROGRESS_MS = 10_000;

/**
 * How long shutdown waits for an engine to exit on its own before killing it.
 *
 * Short, and deliberately shorter than the engine's own teardown can take. Electron's
 * entire main-process cleanup budget is ten seconds; spending most of it waiting for a
 * graceful exit would starve everything else that has to run before the app dies, and
 * the fallback — a signal — is not a bad outcome for a process being torn down anyway.
 */
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * engine sessionId → the help-session id holding its MCP bearer.
 *
 * Kept beside the service rather than on `LiveSession` because the bearer must be
 * revoked on every teardown path — including the readiness failure that happens before
 * a `LiveSession` exists.
 */
const helpSessionIdBySession = new Map<string, string>();

/** Revokes and forgets the MCP bearer belonging to an engine session. */
function revokeHelpSessionFor(sessionId: string): void {
  const helpSessionId = helpSessionIdBySession.get(sessionId);
  if (!helpSessionId) return;
  helpSessionIdBySession.delete(sessionId);
  void helpSessionService.revokeSession(helpSessionId).catch((error: unknown) => {
    logger.warn("MCP revoke failed", { sessionId, error: formatErrorMessage(error, "unknown") });
  });
}

/**
 * Where native-engine debug logs are written: `~/.daintree/logs`.
 *
 * The ENGINE's own default, restated here rather than left unset, so the value is
 * visible from the host side and the same on every platform.
 *
 * It used to be `userData/assistant-logs` — Daintree-owned, beside the app's other
 * data, which sounds tidier and was wrong for the one thing a debug log is for. There
 * were then three answers to "where is the trace?": the CLI wrote one place, the app
 * wrote another, and the settings switch described a third. Someone reproducing a bad
 * turn in the terminal and then in the panel got two files in two trees, and `ls -lt`
 * on the directory they knew about showed neither. One directory, shared with the CLI,
 * is worth more than tidiness.
 */
function assistantLogDir(): string {
  return path.join(app.getPath("home"), ".daintree", "logs");
}

/**
 * The engine's own tier vocabulary (`internal/domain/enums.go`). Anything outside this
 * set is either a refused handshake or a silent re-tiering at the far end.
 */
type EngineTier = "supervisor" | "operator" | "system";

/**
 * Daintree's Help tier → the engine's own tier vocabulary.
 *
 * Two separate ladders that happen to share one name. The engine defaults an UNSET
 * tier to its widest (`system`), so failing to map this is not a missing feature — it
 * silently runs every native session at maximum authority regardless of what the
 * user's assistant settings say.
 *
 * The result is never blank. The engine's descriptor parser rejects an empty `tier`
 * outright, so "say nothing and let the engine decide" is not an option on this side
 * of the wire even when it would resolve to the same value.
 *
 * The parameter stays a plain `string` because the runtime input is a STORED value that
 * a hand-edited or downgraded settings file is free to make nonsense of; the return type
 * is narrow so that a future edit to the mapping has to be a deliberate one.
 */
export function engineTierFor(helpTier: string): EngineTier {
  switch (helpTier) {
    case "workbench":
      return "supervisor";
    case "action":
      return "operator";
    case "system":
      return "system";
    default:
      // Unknown tiers resolve DOWN, never up.
      return "supervisor";
  }
}

export class AssistantHostService {
  /**
   * The detached-timer route.
   *
   * Owned here because this is where the endpoint is learned — `host:ready` is the
   * only place the daemon's socket path is ever spoken — and because this service
   * already outlives any one session.
   */
  readonly timers = new AssistantTimerService();

  /**
   * `assistantSlotKey(projectId, slot)` → live session.
   *
   * The one-engine-per-lane rule lives in this keying. It used to be keyed by project
   * alone, which is exactly what made a second Daintree Assistant session impossible:
   * every start found the project's existing engine and joined it, so both tabs drew
   * one conversation.
   */
  private readonly bySlotKey = new Map<string, LiveSession>();
  /** sessionId → live session, for command routing. */
  private readonly bySession = new Map<string, LiveSession>();
  /** Slot key → tail of the in-flight start chain. See `start`. */
  private readonly startQueue = new Map<string, Promise<unknown>>();
  /**
   * Set once the app is shutting down. New starts are refused from here on.
   *
   * Without it, `shutdown()` can take a snapshot of the live sessions while a start is
   * still queued or awaiting provisioning — and that start then spawns an engine after
   * the teardown pass has already run, into a process that is about to exit. The child
   * outlives Daintree holding the project's state lease, and the next launch waits for
   * a lease held by nothing anyone can see.
   */
  private closing = false;
  /**
   * Every host that has been SPAWNED and has not yet exited — including ones already
   * draining.
   *
   * `bySession` is not enough to tear down from, and the gap is the whole failure this
   * phase is about. `stop()` removes a session from both maps immediately, while
   * `dispose()` only writes a shutdown frame and arms an UNREF'D kill backstop. So an
   * engine displaced by a restart, evicted with its view, or dropped by a failed start
   * is gone from the maps while its process is still very much alive — invisible to a
   * teardown that snapshots `bySession`, and orphaned when `app.exit()` discards the
   * timer that was going to kill it.
   *
   * Entries are removed when the child actually exits, not when Daintree stops caring.
   */
  private readonly spawnedHosts = new Set<AssistantHostProcess>();
  /**
   * Surfaces that went away while one of their own starts was still queued.
   *
   * `startQueue` serializes per project, so a second window's start can still be
   * waiting when its view is destroyed — and the teardown that would have removed it
   * runs BEFORE it was ever registered. Registering it afterwards leaves a subscriber
   * that nothing will ever remove, which holds the engine (and the project's lease)
   * open forever, because lazy reaping only happens when an event is delivered and a
   * quiet engine delivers nothing.
   *
   * An entry is cleared by the next `start` from that surface: an IPC call is proof the
   * renderer is alive again, which also makes this safe against WebContents id reuse.
   */
  private readonly departedSurfaces = new Set<number>();

  /**
   * Starts an engine for a project, displacing any existing one.
   *
   * Resolution failures are thrown rather than swallowed: the message from
   * `resolveAssistantBinary` names the actual fix (check out the submodule, build the
   * engine), and a silent failure here would present as an assistant that simply
   * never answers.
   */
  async start(opts: StartSessionOptions): Promise<AssistantHostStartResult> {
    if (this.closing) throw new Error("Daintree is shutting down");
    // Refused here rather than spawned and left to fail: the engine takes its project
    // lease before opening the database, through a lock with no Windows port, so the
    // child would boot and die with `ipc: file locks are not supported on this
    // platform`. Defence in depth — the panel does not offer the launch — but reachable
    // by direct IPC, and cheap. See `assistantPlatformSupport`.
    //
    // `process.platform` explicitly: this runs in MAIN, where it is the authority, and
    // the shared helper's renderer fallback has no business deciding it here.
    const platform = assistantPlatformSupport(process.platform);
    if (!platform.supported) throw new Error(`${platform.reason}. ${platform.detail}`);
    // This call came FROM the renderer, so the surface is alive right now — whatever a
    // previous teardown recorded about it is stale.
    this.departedSurfaces.delete(opts.webContentsId);
    // Serialized per LANE. `start` awaits twice — the displacement grace period and
    // the engine's own readiness — and the one-per-lane invariant lives in a plain
    // Map, so two overlapping starts could both clear the lane entry and then both
    // register, leaving an engine that nothing can find and nothing will displace.
    // Chaining keeps "displace, register, become ready" indivisible per lane.
    //
    // Per lane rather than per project on purpose: two lanes of one project have
    // separate state namespaces and therefore separate leases, so making the second
    // one queue behind the first would serialize two starts that do not contend —
    // adding the whole of a cold engine boot to opening a parallel session.
    // Normalized BEFORE the key is built, and the normalized value is what runs.
    // Keying on the raw slot let `{slot: 9}` and `{slot: 0}` queue separately and then
    // both resolve to lane 0 inside — two starts racing on one lane, both passing the
    // empty-lane check, both spawning, and the loser left in `bySession` only: an engine
    // holding lane 0's lease that no later start can find or displace.
    const slot = isValidAssistantSlot(opts.slot) ? opts.slot : DEFAULT_ASSISTANT_SLOT;
    const slotKey = assistantSlotKey(opts.projectId, slot);
    const prior = this.startQueue.get(slotKey) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => this.startLocked({ ...opts, slot }));
    const settled = run.catch(() => undefined);
    this.startQueue.set(slotKey, settled);
    // Identity-checked so a later start that already replaced this tail is not
    // dropped. Without it the map retains one settled promise per lane key it has
    // ever seen, which project ids arriving over IPC make unbounded.
    void settled.then(() => {
      if (this.startQueue.get(slotKey) === settled) {
        this.startQueue.delete(slotKey);
      }
    });
    return run;
  }

  private async startLocked(opts: StartSessionOptions): Promise<AssistantHostStartResult> {
    // Every log line below carries this, so a start that stalls says WHERE it stalled
    // rather than only that it did.
    const startedAt = Date.now();
    const elapsedMs = () => Date.now() - startedAt;
    // Already normalized by `start`, which has to know the lane to key the queue on it.
    // Re-resolved rather than asserted so a direct call from a test still means lane 0.
    const slot = isValidAssistantSlot(opts.slot) ? opts.slot : DEFAULT_ASSISTANT_SLOT;
    const slotKey = assistantSlotKey(opts.projectId, slot);
    logger.info("engine start requested", {
      projectId: opts.projectId,
      slot,
      cwd: opts.cwd,
      windowId: opts.windowId,
      webContentsId: opts.webContentsId,
    });

    // One engine per LANE, shared by every surface showing that lane.
    //
    // A second window JOINS the running session. It cannot start its own — the engine
    // holds an exclusive flock lease on the lane's state, so a sibling queues behind
    // it and times out — and it must not displace the first, which is what shipped
    // before: opening a project in a second window silently tore down the conversation
    // the first window was showing.
    const existing = this.bySlotKey.get(slotKey);
    if (existing && !existing.host.hasExited()) {
      return this.attach(existing, opts, elapsedMs());
    }

    // Only a session belonging to THIS lane is displaced — a view re-running its
    // start effect, or switching projects, must be able to replace its own engine,
    // and must not reach a sibling lane's.
    await this.stopSlot(slotKey);

    // Logged as well as thrown. The renderer surfaces this one, but a resolution failure
    // names a build step someone has to run, and the main log is where they will look for
    // it after the panel has been closed.
    const engine = await resolveAssistantBinary().catch((error: unknown) => {
      logger.error("engine start failed: no engine binary", error, { elapsedMs: elapsedMs() });
      throw error;
    });
    const binaryPath = engine.path;
    const sessionId = `ses_${randomBytes(8).toString("hex")}`;
    // Which copy of the engine a session ran is acceptance evidence, not chatter. A
    // packaged run only proves the shipped artifact when the source is `packaged`, and
    // `scripts/afterPack.cjs` has already matched THAT binary's SHA against the
    // gitlink — so the one line is recorded every start, and says more when the answer
    // is one an acceptance run must not accept. Once per engine start, not per turn.
    const substituted = app.isPackaged && engine.source !== "packaged";
    if (substituted) {
      logger.warn(
        `Engine resolved from ${engine.source}: ${ASSISTANT_BIN_ENV} selected this instead of ` +
          `the engine this app ships. Unset ${ASSISTANT_BIN_ENV} and relaunch to test the ` +
          `packaged engine.`,
        { sessionId, binaryPath, source: engine.source, elapsedMs: elapsedMs() }
      );
    } else {
      logger.info(`Engine resolved from ${engine.source}`, {
        sessionId,
        binaryPath,
        source: engine.source,
        elapsedMs: elapsedMs(),
      });
    }

    // Provision the MCP binding BEFORE spawning, in main, next to the service that
    // issues it. Without this the engine starts fine and answers fine — it just has no
    // control plane, so every attempt to spawn an agent fails with "Daintree MCP is not
    // connected". That reads as a broken assistant rather than a missing binding, which
    // is why it is provisioned here rather than left for a later call to add.
    //
    // Not fatal, but never silent. A conversation without Daintree tools is degraded
    // rather than useless — the user can still ask things — so failing the whole start
    // would turn a missing control plane into a panel that cannot open at all. But
    // `provisionSession` throws a TYPED reason when the MCP server is not ready, and
    // swallowing it is precisely the silent-degrade this codebase already fixed once
    // for the PTY path. The reason is carried back to the renderer, which says so.
    let mcp: { url: string | null; token: string } | null = null;
    let mcpUnavailableReason: string | null = null;
    /**
     * The session's tier, in the ENGINE's vocabulary, decided exactly once.
     *
     * There used to be two answers. The descriptor carried the renderer's requested
     * tier (defaulting to `system`) and the environment carried the provisioned tier
     * mapped into the engine's ladder (defaulting to `operator` for the shipped
     * `action` setting) — and the engine compares the two and refuses to boot when
     * they disagree. So a default install could not start the native assistant at all:
     * every launch died on `binding-mismatch` before reaching ready.
     *
     * Seeded from the stored setting so a failed provision still has an answer, then
     * overwritten below with the tier the MCP bearer was actually minted at. Reading
     * the setting again after provisioning would reintroduce a smaller version of the
     * same bug — a tier changed mid-launch would leave the engine at one authority and
     * its bearer at another.
     */
    let engineTier = engineTierFor(getHelpAssistantSettings().tier);
    // Resolved BEFORE provisioning, from the stored preference, so a launch that fails
    // to provision still writes a trace. Overwritten below with the session's own
    // snapshot on the happy path, which is the same value unless the setting changed in
    // between.
    let debugLogging = helpSessionService.getDebugLoggingPreference();
    // The user's "auto-approve assistant actions" preference. Read from the SAME
    // provisioned session the PTY path reads it from (terminal/lifecycle.ts), so the
    // native panel and a terminal-hosted assistant honour one setting rather than two.
    let autoApprove = false;
    try {
      const provisioned = await helpSessionService.provisionSession({
        projectId: opts.projectId,
        projectPath: opts.cwd,
        agentId: ASSISTANT_AGENT_ID,
        // The lane, so a parallel session provisions its own bearer instead of
        // displacing its sibling's. `displacePriorSessions` is keyed on
        // `(projectId, slot)`, which is what keeps lane 0's MCP binding alive when
        // lane 1 starts.
        slot,
        windowId: opts.windowId,
        projectViewWebContentsId: opts.webContentsId,
      });
      if (provisioned) {
        // Exempt from the orphan sweep: it binds an engine, not a terminal, and the
        // sweeper would otherwise revoke this bearer 30 minutes into a live session.
        helpSessionService.markEngineSession(provisioned.sessionId);
        mcp = { url: provisioned.mcpUrl, token: provisioned.token };
        // The tier the bearer was MINTED at, which is the one the control plane will
        // actually enforce. Daintree control being switched off does not reach this
        // branch differently — provisioning still returns a tier, with `mcpUrl` null.
        engineTier = engineTierFor(provisioned.tier);
        debugLogging = helpSessionService.getDebugLogging(provisioned.token);
        autoApprove = helpSessionService.getBypassPermissions(provisioned.token);
        helpSessionIdBySession.set(sessionId, provisioned.sessionId);
        if (!provisioned.mcpUrl) {
          mcpUnavailableReason = "Daintree control is switched off in assistant settings.";
        }
        // The three env-borne decisions in one line. Each of them changes how the child
        // behaves before it says anything, and a tier that disagrees with the bearer is
        // refused by the engine at handshake — a failure whose only visible symptom is
        // a start that never becomes ready.
        logger.info("MCP session provisioned", {
          sessionId,
          tier: engineTier,
          mcp: Boolean(mcp?.url),
          autoApprove,
          debugLogging,
          elapsedMs: elapsedMs(),
        });
      } else {
        mcpUnavailableReason = "The assistant session could not be provisioned.";
        logger.warn("MCP session not provisioned; engine starts without a control plane", {
          sessionId,
          elapsedMs: elapsedMs(),
        });
      }
    } catch (error) {
      mcpUnavailableReason = formatErrorMessage(
        error,
        "The Daintree control plane could not be reached."
      );
      logger.warn("MCP provisioning failed", {
        sessionId,
        error: formatErrorMessage(error, "unknown"),
        elapsedMs: elapsedMs(),
      });
    }

    const host = new AssistantHostProcess({
      binaryPath,
      cwd: opts.cwd,
      descriptor: {
        sessionId,
        windowId: opts.windowId,
        projectId: opts.projectId,
        cwd: opts.cwd,
        tier: engineTier,
        protocolVersion: ASSISTANT_HOST_PROTOCOL_VERSION,
      },
      env: {
        // Inherited MINUS the control variables — see `assistantChildEnv`.
        //
        // `DAINTREE_BACKEND_URL` is deliberately NOT among what we set. Daintree used to
        // pin the endpoint here from a Settings picker, and the engine reads that
        // variable as a pin by a host: it outranks the stored choice at every launch and
        // makes the endpoint unswitchable from inside the session (`ErrBackendPinned`),
        // so `/backend` could report a switch it was never allowed to make. The endpoint
        // belongs to the engine, which remembers its own choice across restarts and can
        // explain it — the picker, and the account that had to agree with it, went the
        // same way. The variable is still STRIPPED from what is inherited, which is the
        // half that was ever load-bearing.
        ...assistantChildEnv(),
        // Nothing from the renderer reaches here, deliberately: a renderer-supplied
        // bag would let a compromised view repoint the engine or hand itself standing
        // approval. Secrets are provisioned in main, next to the service issuing them.
        DAINTREE_PROJECT_ID: opts.projectId,
        DAINTREE_WINDOW_ID: String(opts.windowId),
        // An unpackaged build gets its own per-project state.
        //
        // A project's state is owned exclusively — one process holds `owner.lock` and
        // with it the right to open `state.db` — so a dev build and the installed app
        // open on the SAME project cannot both run an assistant. The second waits out
        // its deadline and reports the project busy, which is what a developer running
        // both hits every single time.
        //
        // The namespace moves only the PER-PROJECT directory, not the state root: the
        // dev build is the same account talking to the same backend, with its own
        // conversation and its own lease for that project. Which is also the right
        // default on its own merits — a dev build's experiments have no business
        // writing into the memories, audit trail and automation grants the installed
        // app is using for real work.
        //
        // Packaged builds never set it: Electron's single-instance lock means two of
        // them cannot run at once, so they have nothing to contend with.
        //
        // A PARALLEL LANE uses the same lever for the same reason (#12108). Lanes 1+
        // append their own suffix, so each one opens its own `state.db` behind its own
        // `owner.lock` — which is the whole of what makes two Daintree Assistant
        // sessions run at once, rather than the second waiting out its deadline on a
        // lease the first holds. Slot 0's namespace is byte-identical to what shipped,
        // so an existing conversation is exactly where it was.
        ...namespaceEnv(slot),
        // The SAME value the descriptor above carries. The engine cross-checks the two
        // and treats a disagreement as fatal, so this is one variable holding one
        // decision rather than two independent derivations that happen to agree.
        DAINTREE_ASSISTANT_TIER: engineTier,
        // The assistant has no --dangerously-skip-permissions flag; the preference maps
        // to skipping its own confirm sheet, which the engine reads from here at
        // startup. Set only when ON: the variable is stripped from inherited env
        // above, so leaving it unset is what "ask me" means.
        //
        // Without this the toggle did nothing on the native panel — the sheet appeared
        // for a user who had switched it off, which reads as the setting being broken.
        ...(autoApprove ? { DAINTREE_ASSISTANT_AUTO_APPROVE: "1" } : {}),
        // Debug logging, from the same assistant setting the PTY path reads. Both
        // halves are required — the engine writes nothing unless it has a flag AND a
        // directory — which is why the native path produced no log at all until now,
        // and why a session that misbehaves had no trace to read afterwards.
        ...(debugLogging
          ? {
              DAINTREE_ASSISTANT_DEBUG_LOG: "1",
              DAINTREE_ASSISTANT_LOG_DIR: assistantLogDir(),
            }
          : {}),
        // Provisioned above. Spread conditionally so an absent binding leaves the
        // variables UNSET rather than set-to-empty: the engine treats empty as
        // "configured but broken" and reports a connection error, where unset is the
        // honest "no control plane" it already knows how to degrade around.
        ...(mcp?.url ? { DAINTREE_MCP_URL: mcp.url, DAINTREE_MCP_TOKEN: mcp.token } : {}),
      },
      onEvent: (event) => this.broadcast(sessionId, CHANNELS.ASSISTANT_HOST_EVENT, event),
      onSequenceGap: (info) =>
        this.broadcast(sessionId, CHANNELS.ASSISTANT_HOST_GAP, { sessionId, ...info }),
      onDiagnostic: (line) => {
        // Engine diagnostics are developer-facing, not conversation. They go to the
        // main log rather than the transcript, exactly as stderr is separated from the
        // protocol stream on the wire.
        logger.warn(line, { sessionId });
      },
      onExit: (code, signal) => {
        logger.info("engine exited", { sessionId, code, signal, elapsedMs: elapsedMs() });
        this.spawnedHosts.delete(host);
        // Read the watchers BEFORE deregistering: every surface showing this session
        // has to be told it ended, and `broadcast` resolves through the map this is
        // about to clear.
        const watching = [...(this.bySession.get(sessionId)?.subscribers.keys() ?? [])];
        this.bySession.delete(sessionId);
        revokeHelpSessionFor(sessionId);
        if (this.bySlotKey.get(slotKey)?.sessionId === sessionId) {
          this.bySlotKey.delete(slotKey);
        }
        // Falls back to the starter when the session never registered: a start that
        // failed before registration still has a panel waiting for an answer.
        for (const webContentsId of watching.length > 0 ? watching : [opts.webContentsId]) {
          this.deliver(webContentsId, CHANNELS.ASSISTANT_HOST_EXIT, { sessionId, code, signal });
        }
      },
    });

    // Registered the moment it exists, and removed only when the child actually exits
    // (see `onExit` above) — never when Daintree merely stops tracking the session.
    this.spawnedHosts.add(host);

    const attachmentId = newAttachmentId();
    const session: LiveSession = {
      sessionId,
      projectId: opts.projectId,
      slot,
      host,
      provisionerWebContentsId: opts.webContentsId,
      subscribers: new Map([[opts.webContentsId, { windowId: opts.windowId, attachmentId }]]),
    };
    this.bySlotKey.set(slotKey, session);
    this.bySession.set(sessionId, session);

    // Beats while the handshake is outstanding. `host.start()` returning says only that
    // a child was forked; readiness is the engine answering, and the gap between the two
    // is the whole of what "starting" means on screen.
    const readyProgress = setInterval(() => {
      logger.warn("engine has not signalled ready yet", {
        sessionId,
        pid: host.getPid(),
        elapsedMs: elapsedMs(),
      });
    }, READY_PROGRESS_MS);
    readyProgress.unref?.();

    if (this.closing) {
      // Shutdown began, and swept, while this start was resolving its binary and
      // provisioning. Spawning now produces a child nothing will reap: the sweep has
      // already taken its snapshot, and `app.exit()` is moments away — leaving an
      // engine orphaned and holding the project's lease.
      this.bySession.delete(sessionId);
      revokeHelpSessionFor(sessionId);
      if (this.bySlotKey.get(slotKey)?.sessionId === sessionId) {
        this.bySlotKey.delete(slotKey);
      }
      this.spawnedHosts.delete(host);
      throw new Error("Daintree is shutting down");
    }

    try {
      // `host.start()` is INSIDE the try: child_process.spawn validates its options
      // synchronously and throws for things like a NUL byte in cwd. That throw produces
      // no child and no exit event, so escaping here would strand a registered session,
      // a live MCP bearer and its sweep exemption with nothing left to clean them up.
      host.start();
      logger.info("engine spawned; awaiting host:ready", {
        sessionId,
        pid: host.getPid(),
        binaryPath,
        cwd: opts.cwd,
        tier: engineTier,
        elapsedMs: elapsedMs(),
      });
      await host.waitForReady();
      // Remember where this project's supervisor daemon listens, while an engine is
      // here to tell us. It is the ONLY moment the answer is available: the daemon
      // outlives the session, but nothing else in Daintree can work out its socket
      // path — that would mean reimplementing two of the engine's hashes and failing
      // silently the day either drifted. Learned once, used after the engine is gone.
      const ready = host.getReadyEvent();
      if (ready?.controlSocket) {
        // Per LANE, not per project: each lane runs in its own state namespace, so
        // each has its own state dir, its own supervisor socket and its own timer
        // table. Keyed by project alone, whichever lane became ready last would answer
        // for all of them once the engines were gone.
        this.timers.rememberEndpoint(opts.projectId, slot, {
          socketPath: ready.controlSocket,
          stateDir: ready.stateDir,
        });
      }
      logger.info("engine ready", {
        sessionId,
        pid: host.getPid(),
        engineVersion: ready?.version ?? null,
        elapsedMs: elapsedMs(),
      });
    } catch (error) {
      // Clean up rather than leaving a half-registered session that commands would
      // route to and silently drop.
      //
      // The lane entry is removed only if it is still OURS. A displaced engine can
      // take up to `GRACEFUL_EXIT_MS` to die while its replacement is already
      // registered, so an unconditional delete here evicts the live successor and
      // leaves it invisible to `stopSlot` — an engine nothing can displace, holding
      // the lane's lease against every later start.
      logger.error("engine start failed", error, {
        sessionId,
        pid: host.getPid(),
        elapsedMs: elapsedMs(),
      });
      this.bySession.delete(sessionId);
      revokeHelpSessionFor(sessionId);
      if (this.bySlotKey.get(slotKey)?.sessionId === sessionId) {
        this.bySlotKey.delete(slotKey);
      }
      host.dispose();
      throw error;
    } finally {
      clearInterval(readyProgress);
    }

    // The surface went away while this start was queued behind another. Registering it
    // would leave a subscriber nothing can remove.
    if (this.departedSurfaces.has(opts.webContentsId)) {
      this.detach(session, opts.webContentsId);
      throw new Error("The assistant panel closed before its engine finished starting.");
    }

    return {
      sessionId,
      attachmentId,
      replayPrompts: [],
      replayTruncated: false,
      ready: host.getReadyEvent(),
      // Anything the engine said before the renderer could know its session id — the
      // control-plane status among them. Handed back rather than left in that gap.
      replay: host.takePreReadyEvents(),
      mcpUnavailableReason,
    };
  }

  /**
   * Sends a command to a live session. Returns false when the session is gone.
   *
   * `fromWebContentsId` names the surface that sent it, which matters for two things a
   * shared engine cannot get right on its own: mirroring the prompt to the other
   * windows, and moving the control plane to the window the user is actually using.
   */
  send(command: AssistantHostCommand, fromWebContentsId?: number): boolean {
    const session = this.bySession.get(command.sessionId);
    if (!session) return false;
    const delivered = session.host.send(command);
    if (!delivered || command.type !== "prompt") return delivered;

    // The engine never echoes a prompt: a user turn exists only in the store of the
    // renderer that submitted it. So the host records it for anyone joining later and
    // mirrors it to the surfaces already watching — without this the windows sharing
    // one engine diverge on the first message either of them sends, one showing a
    // question with no answer and the other an answer with no question.
    session.host.recordPrompt(command.text);
    for (const webContentsId of [...session.subscribers.keys()]) {
      if (webContentsId === fromWebContentsId) continue;
      this.deliver(webContentsId, CHANNELS.ASSISTANT_HOST_PEER_PROMPT, {
        sessionId: session.sessionId,
        text: command.text,
      });
    }

    // NOT re-pinned to the sender. The MCP layer snapshots a session's view at
    // handshake and never re-points it, deliberately (#7003/#9887), so tool calls act
    // on the window that started the engine no matter which window typed. Mutating the
    // record here would look like it moved the control plane and move nothing.
    return delivered;
  }

  /** Stops one session. */
  stop(sessionId: string): void {
    const session = this.bySession.get(sessionId);
    if (!session) return;
    this.bySession.delete(sessionId);
    revokeHelpSessionFor(sessionId);
    const slotKey = assistantSlotKey(session.projectId, session.slot);
    if (this.bySlotKey.get(slotKey)?.sessionId === sessionId) {
      this.bySlotKey.delete(slotKey);
    }
    session.host.dispose();
  }

  /** Adds a surface to a session that is already running, and hands it the conversation. */
  private attach(
    session: LiveSession,
    opts: StartSessionOptions,
    elapsedMs: number
  ): AssistantHostStartResult {
    const attachmentId = newAttachmentId();
    session.subscribers.set(opts.webContentsId, { windowId: opts.windowId, attachmentId });
    if (this.departedSurfaces.has(opts.webContentsId)) {
      this.detach(session, opts.webContentsId);
      throw new Error("The assistant panel closed before its engine finished starting.");
    }
    const transcript = session.host.getTranscript();
    logger.info("surface joined the lane's running engine", {
      sessionId: session.sessionId,
      projectId: opts.projectId,
      slot: session.slot,
      webContentsId: opts.webContentsId,
      subscribers: session.subscribers.size,
      replayEvents: transcript.events.length,
      replayPrompts: transcript.prompts.length,
      replayTruncated: transcript.truncated,
      elapsedMs,
    });
    return {
      sessionId: session.sessionId,
      attachmentId,
      // The joiner needs the same readiness frame the first surface got: it carries the
      // engine version and whether approvals are switched off, and a panel that never
      // applies it renders a session it believes nothing about.
      ready: session.host.getReadyEvent(),
      replay: transcript.events,
      replayPrompts: transcript.prompts,
      replayTruncated: transcript.truncated,
      // Provisioning belongs to the engine's own start. A joiner did not do one, and a
      // stale reason here would put a control-plane warning on a panel whose control
      // plane is whatever the running engine actually has.
      mcpUnavailableReason: null,
    };
  }

  /** Sends one payload to every surface watching a session. */
  private broadcast(sessionId: string, channel: string, payload: unknown): void {
    const session = this.bySession.get(sessionId);
    if (!session) return;
    // Copied: `deliver` detaches a surface whose view has gone, which mutates the map
    // being walked.
    for (const webContentsId of [...session.subscribers.keys()]) {
      this.deliver(webContentsId, channel, payload);
    }
  }

  /**
   * Detaches one surface, stopping the engine when the last one leaves.
   *
   * `attachmentId`, when given, must match the CURRENT attachment for that surface. A
   * panel re-running its start effect resolves the new attach before the old one's
   * teardown runs, so an unqualified detach would remove the live attachment and stop
   * an engine that something is still using.
   */
  private detach(session: LiveSession, webContentsId: number, attachmentId?: string): void {
    const subscriber = session.subscribers.get(webContentsId);
    if (!subscriber) return;
    if (attachmentId !== undefined && subscriber.attachmentId !== attachmentId) return;
    session.subscribers.delete(webContentsId);

    if (session.subscribers.size > 0 && webContentsId !== session.provisionerWebContentsId) {
      logger.info("surface left the project's engine; others remain", {
        sessionId: session.sessionId,
        webContentsId,
        subscribers: session.subscribers.size,
      });
      return;
    }
    if (session.subscribers.size > 0) {
      // The surface the control plane is pinned to has gone. The engine could keep
      // talking, but every tool call would target a destroyed view — so end it here
      // rather than leave the other windows with an assistant that answers and cannot
      // act. They get an ordinary exit and can start it again.
      logger.info("the surface holding the control plane left; ending the shared session", {
        sessionId: session.sessionId,
        webContentsId,
        strandedSubscribers: session.subscribers.size,
      });
    }
    logger.info("last surface left; stopping the engine", {
      sessionId: session.sessionId,
      webContentsId,
    });
    this.stop(session.sessionId);
  }

  /** Detaches one surface's attachment, by id. */
  detachSession(sessionId: string, webContentsId: number, attachmentId: string): void {
    const session = this.bySession.get(sessionId);
    if (session) this.detach(session, webContentsId, attachmentId);
  }

  /** Stops whatever session a lane has, if any. */
  private async stopSlot(slotKey: string): Promise<void> {
    const existing = this.bySlotKey.get(slotKey);
    if (!existing) return;
    this.stop(existing.sessionId);
    // Give the displaced engine a moment to release the lane's state lease. Without
    // it the incoming engine can lose a race against an owner that is still exiting,
    // and fail its own startup for a reason that looks like nothing to do with this.
    await new Promise((r) => setTimeout(r, 250));
  }

  /**
   * Tears down every session and WAITS for the children to go.
   *
   * `stop` is not enough on its own at quit. It writes a shutdown frame, closes stdin
   * and arms an UNREF'D kill backstop — deliberately, so a displaced engine cannot hold
   * the app open — and then returns immediately. At shutdown that unref'd timer is a
   * promise the process will not be around to keep: Electron calls `app.exit()` and the
   * timer dies with it, leaving any engine that did not manage a clean exit orphaned,
   * still holding its project's state lease. A spawned child is not reaped with its
   * parent.
   *
   * So this asks nicely, waits a bounded moment, and then kills what is left — while
   * there is still a process alive to do the killing. The budget is small on purpose:
   * Electron's whole main-process cleanup window is ten seconds, and the engine's own
   * teardown can want longer than that, so waiting for a graceful exit that may never
   * come would spend the entire budget here.
   */
  async shutdown(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    // Refuse new starts FIRST, before the first await, so nothing can slip in behind
    // the teardown.
    this.closing = true;

    // Stop what is live NOW, before draining. The order matters: a start already past
    // the `closing` check can be sitting on binary resolution, on provisioning, or on
    // the engine's own 90-second readiness deadline — and draining first would spend
    // the entire shutdown budget waiting for it while every engine that is already
    // running went untouched. Ask them all to stop first; the drain is only about
    // catching whatever spawned during it.
    for (const session of [...this.bySession.values()]) this.stop(session.sessionId);

    // Then give the in-flight starts a BOUNDED moment to settle. Whatever they spawn
    // lands in `spawnedHosts` and is stopped in the second pass below. Bounded because
    // this is a quit: a start that has not finished by now is not going to be waited
    // for, and its child is reaped by the same pass as everything else.
    await Promise.race([
      Promise.allSettled([...this.startQueue.values()]),
      new Promise((resolve) => setTimeout(resolve, graceMs).unref?.()),
    ]);
    for (const session of [...this.bySession.values()]) this.stop(session.sessionId);

    // Wait on every host that has ever been spawned and not yet exited — including the
    // ones already draining from an earlier displacement or eviction, which the session
    // maps no longer know about at all.
    await Promise.all([...this.spawnedHosts].map((host) => host.waitForExit(graceMs)));
  }

  /** Tears down every session without waiting. Retained for non-shutdown callers. */
  disposeAll(): void {
    for (const sessionId of [...this.bySession.keys()]) this.stop(sessionId);
  }

  /**
   * Sends to the pinned renderer, failing closed if it is gone.
   *
   * "Failing closed" is the point: a destroyed or crashed view must drop the payload,
   * not fall back to some other window. That fallback is what lesson #7003 is about.
   */
  private deliver(webContentsId: number, channel: string, payload: unknown): void {
    const target: WebContents | undefined = webContents.fromId(webContentsId) ?? undefined;
    if (!target || target.isDestroyed()) {
      // This surface is gone, so nothing will ever detach it from the renderer side —
      // the panel that would have run its cleanup no longer exists. Detach it here,
      // which reaps the engine only when it was the last one watching.
      this.stopByWebContents(webContentsId);
      return;
    }
    try {
      target.send(channel, payload);
    } catch {
      // Destroyed between the check above and this line. Electron throws synchronously
      // here, and this runs inside a child stdout callback — letting it escape would
      // surface as an unhandled error in the main event loop rather than as the owner
      // going away, which is all it is.
      this.stopByWebContents(webContentsId);
    }
  }

  /**
   * Detaches a renderer from every session it was watching (destroyed view, crashed view).
   *
   * Named `stop*` for its callers, who mean "this surface is gone" — but a surface
   * going away only ENDS the engine when no other window is still showing it.
   *
   * The surface is also recorded as departed, because one of its own starts may still
   * be queued behind another project's: registering it afterwards would leave a
   * subscriber nothing can ever remove.
   */
  stopByWebContents(webContentsId: number): void {
    this.departedSurfaces.add(webContentsId);
    for (const session of [...this.bySession.values()]) this.detach(session, webContentsId);
  }

  /**
   * Stops every session owned by a window (window closed).
   *
   * A linear scan rather than a second index: there are at most three engines per
   * project and a handful of projects, so the map is tiny — and a second index would have to be
   * kept consistent through displacement, failed starts and exits, which is more ways to
   * be wrong than it saves work.
   *
   * Window ids are reused, so this has to run while the window is being unregistered
   * rather than lazily afterwards: by the time an id comes round again it names a
   * different window, and a session left behind is one nothing will ever match.
   */
  stopByWindow(windowId: number): void {
    for (const session of [...this.bySession.values()]) {
      for (const [webContentsId, subscriber] of [...session.subscribers]) {
        if (subscriber.windowId === windowId) {
          this.departedSurfaces.add(webContentsId);
          this.detach(session, webContentsId);
        }
      }
    }
  }

  /** True when `webContentsId` is one of the surfaces watching `sessionId`. */
  isOwnedBy(sessionId: string, webContentsId: number): boolean {
    return this.bySession.get(sessionId)?.subscribers.has(webContentsId) ?? false;
  }
}

export const assistantHostService = new AssistantHostService();

/** Re-exported for the IPC layer's typing. */
export type { AssistantHostEvent };

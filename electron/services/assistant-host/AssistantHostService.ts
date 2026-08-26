import { app, webContents, type WebContents } from "electron";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AssistantHostProcess } from "./AssistantHostProcess.js";
import { resolveAssistantBinary } from "./resolveAssistantBinary.js";
import { assistantPlatformSupport } from "../../../shared/config/assistantPlatform.js";
import { assistantChildEnv } from "./assistantChildEnv.js";
import { getHelpAssistantSettings } from "../../ipc/handlers/helpAssistant.js";
import { helpSessionService } from "../HelpSessionService.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  ASSISTANT_HOST_PROTOCOL_VERSION,
  type AssistantHostCommand,
  type AssistantHostEvent,
} from "../../../shared/types/ipc/assistantHost.js";
import { CHANNELS } from "../../ipc/channels.js";
import type { AssistantHostStartResult } from "../../../shared/types/ipc/assistantHostIpc.js";

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
 * 2. **One engine per project** (#7522). Starting a session for a project that already
 *    has one displaces the old one rather than running two. Two engines would both
 *    hold the project's state lease and fight over it.
 */

export interface StartSessionOptions {
  projectId: string;
  /** Project root; the engine's working directory. */
  cwd: string;
  windowId: number;
  /** The renderer that owns this session. Events are pinned to it. */
  webContentsId: number;
}

interface LiveSession {
  sessionId: string;
  projectId: string;
  host: AssistantHostProcess;
  webContentsId: number;
  /**
   * The window that owns this session.
   *
   * Recorded alongside the WebContents id because the two are lost at different moments
   * and by different code. A view is evicted or crashes; a window is closed. Both are
   * "the owner is gone", and a session reachable by only one of them survives the other.
   */
  windowId: number;
}

/** The roster id the MCP tier policy is keyed on for this surface. */
const ASSISTANT_AGENT_ID = "daintree-assistant";

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
    console.warn(`[assistant-host:${sessionId}] MCP revoke failed`, error);
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
  /** projectId → live session. The one-per-project rule lives in this keying. */
  private readonly byProject = new Map<string, LiveSession>();
  /** sessionId → live session, for command routing. */
  private readonly bySession = new Map<string, LiveSession>();
  /** projectId → tail of the in-flight start chain. See `start`. */
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
    // Serialized per project. `start` awaits twice — the displacement grace period and
    // the engine's own readiness — and the one-per-project invariant lives in a plain
    // Map, so two overlapping starts could both clear the project entry and then both
    // register, leaving an engine that nothing can find and nothing will displace.
    // Chaining keeps "displace, register, become ready" indivisible per project.
    const prior = this.startQueue.get(opts.projectId) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => this.startLocked(opts));
    const settled = run.catch(() => undefined);
    this.startQueue.set(opts.projectId, settled);
    // Identity-checked so a later start that already replaced this tail is not
    // dropped. Without it the map retains one settled promise per project id it has
    // ever seen, which project ids arriving over IPC make unbounded.
    void settled.then(() => {
      if (this.startQueue.get(opts.projectId) === settled) {
        this.startQueue.delete(opts.projectId);
      }
    });
    return run;
  }

  private async startLocked(opts: StartSessionOptions): Promise<AssistantHostStartResult> {
    // Displace first, and await it, so the outgoing engine has released the project's
    // state lease before the new one tries to take it.
    await this.stopProject(opts.projectId);

    const binaryPath = await resolveAssistantBinary();
    const sessionId = `ses_${randomBytes(8).toString("hex")}`;

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
      } else {
        mcpUnavailableReason = "The assistant session could not be provisioned.";
      }
    } catch (error) {
      mcpUnavailableReason = formatErrorMessage(
        error,
        "The Daintree control plane could not be reached."
      );
      console.warn(`[assistant-host:${sessionId}] MCP provisioning failed`, error);
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
      onEvent: (event) => this.deliver(opts.webContentsId, CHANNELS.ASSISTANT_HOST_EVENT, event),
      onSequenceGap: (info) =>
        this.deliver(opts.webContentsId, CHANNELS.ASSISTANT_HOST_GAP, { sessionId, ...info }),
      onDiagnostic: (line) => {
        // Engine diagnostics are developer-facing, not conversation. They go to the
        // main log rather than the transcript, exactly as stderr is separated from the
        // protocol stream on the wire.
        console.warn(`[assistant-host:${sessionId}] ${line}`);
      },
      onExit: (code, signal) => {
        this.spawnedHosts.delete(host);
        this.bySession.delete(sessionId);
        revokeHelpSessionFor(sessionId);
        if (this.byProject.get(opts.projectId)?.sessionId === sessionId) {
          this.byProject.delete(opts.projectId);
        }
        this.deliver(opts.webContentsId, CHANNELS.ASSISTANT_HOST_EXIT, {
          sessionId,
          code,
          signal,
        });
      },
    });

    // Registered the moment it exists, and removed only when the child actually exits
    // (see `onExit` above) — never when Daintree merely stops tracking the session.
    this.spawnedHosts.add(host);

    const session: LiveSession = {
      sessionId,
      projectId: opts.projectId,
      host,
      webContentsId: opts.webContentsId,
      windowId: opts.windowId,
    };
    this.byProject.set(opts.projectId, session);
    this.bySession.set(sessionId, session);

    try {
      // `host.start()` is INSIDE the try: child_process.spawn validates its options
      // synchronously and throws for things like a NUL byte in cwd. That throw produces
      // no child and no exit event, so escaping here would strand a registered session,
      // a live MCP bearer and its sweep exemption with nothing left to clean them up.
      host.start();
      await host.waitForReady();
    } catch (error) {
      // Clean up rather than leaving a half-registered session that commands would
      // route to and silently drop.
      //
      // The project entry is removed only if it is still OURS. A displaced engine can
      // take up to `GRACEFUL_EXIT_MS` to die while its replacement is already
      // registered, so an unconditional delete here evicts the live successor and
      // leaves it invisible to `stopProject` — an engine nothing can displace, holding
      // the project's lease against every later start.
      this.bySession.delete(sessionId);
      revokeHelpSessionFor(sessionId);
      if (this.byProject.get(opts.projectId)?.sessionId === sessionId) {
        this.byProject.delete(opts.projectId);
      }
      host.dispose();
      throw error;
    }

    return {
      sessionId,
      ready: host.getReadyEvent(),
      // Anything the engine said before the renderer could know its session id — the
      // control-plane status among them. Handed back rather than left in that gap.
      replay: host.takePreReadyEvents(),
      mcpUnavailableReason,
    };
  }

  /** Sends a command to a live session. Returns false when the session is gone. */
  send(command: AssistantHostCommand): boolean {
    const session = this.bySession.get(command.sessionId);
    if (!session) return false;
    return session.host.send(command);
  }

  /** Stops one session. */
  stop(sessionId: string): void {
    const session = this.bySession.get(sessionId);
    if (!session) return;
    this.bySession.delete(sessionId);
    revokeHelpSessionFor(sessionId);
    if (this.byProject.get(session.projectId)?.sessionId === sessionId) {
      this.byProject.delete(session.projectId);
    }
    session.host.dispose();
  }

  /** Stops whatever session a project has, if any. */
  private async stopProject(projectId: string): Promise<void> {
    const existing = this.byProject.get(projectId);
    if (!existing) return;
    this.stop(existing.sessionId);
    // Give the displaced engine a moment to release the project's state lease. Without
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
      // The owner is gone, so nothing will ever stop this engine from the renderer
      // side — the panel that would have run its cleanup no longer exists. Reap it
      // here instead of leaving a headless process holding the project's lease.
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

  /** Stops every session owned by a renderer (destroyed view, crashed view). */
  stopByWebContents(webContentsId: number): void {
    for (const session of [...this.bySession.values()]) {
      if (session.webContentsId === webContentsId) this.stop(session.sessionId);
    }
  }

  /**
   * Stops every session owned by a window (window closed).
   *
   * A linear scan rather than a second index: there is at most one engine per project
   * and a handful of projects, so the map is tiny — and a second index would have to be
   * kept consistent through displacement, failed starts and exits, which is more ways to
   * be wrong than it saves work.
   *
   * Window ids are reused, so this has to run while the window is being unregistered
   * rather than lazily afterwards: by the time an id comes round again it names a
   * different window, and a session left behind is one nothing will ever match.
   */
  stopByWindow(windowId: number): void {
    for (const session of [...this.bySession.values()]) {
      if (session.windowId === windowId) this.stop(session.sessionId);
    }
  }

  /** True when `sessionId` is a live session owned by `webContentsId`. */
  isOwnedBy(sessionId: string, webContentsId: number): boolean {
    return this.bySession.get(sessionId)?.webContentsId === webContentsId;
  }
}

export const assistantHostService = new AssistantHostService();

/** Re-exported for the IPC layer's typing. */
export type { AssistantHostEvent };

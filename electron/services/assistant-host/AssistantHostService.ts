import { app, webContents, type WebContents } from "electron";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AssistantHostProcess } from "./AssistantHostProcess.js";
import { resolveAssistantBinary } from "./resolveAssistantBinary.js";
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
  tier?: string;
}

interface LiveSession {
  sessionId: string;
  projectId: string;
  host: AssistantHostProcess;
  webContentsId: number;
}

/**
 * The assistant backend the engine talks to.
 *
 * Pinned EXPLICITLY, and to localhost, for two reasons. The engine's own default is
 * the deployed `https://assistant.daintree.org`, so inheriting the environment means
 * an unconfigured dev machine — or a test run — silently reaches production and spends
 * real money on model calls. And "which endpoint is this talking to" should be a
 * decision this file makes visibly, not an accident of whatever is exported in the
 * shell that happened to launch Electron.
 *
 * `DAINTREE_BACKEND_URL` still overrides it, because a developer pointing at a staging
 * or deployed backend on purpose is a legitimate thing to do — it just has to be
 * deliberate. Change this constant when the native panel is ready to face the deployed
 * backend by default.
 */
const DEFAULT_BACKEND_URL = "http://127.0.0.1:8473";

/**
 * The backend endpoint for a spawned engine.
 *
 * An explicit override still wins — pointing at staging or the deployed backend on
 * purpose is legitimate, and a pin with no escape hatch just pushes people to edit the
 * constant and commit it by accident. The rule is only that it has to be DELIBERATE.
 *
 * A blank value is therefore treated as ABSENT rather than passed through. The engine
 * reads an empty `DAINTREE_BACKEND_URL` as unset and falls through to the stored
 * `/backend` preference and then to its own deployed default, so forwarding `""` would
 * quietly undo the pin — and do it on the one input a shell most easily produces.
 */
export function resolveBackendUrl(raw: string | undefined): string {
  return raw?.trim() || DEFAULT_BACKEND_URL;
}

/** The roster id the MCP tier policy is keyed on for this surface. */
const ASSISTANT_AGENT_ID = "daintree-assistant";

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
 * Assistant-control variables stripped from the inherited environment.
 *
 * `process.env` is spread into the child so it keeps PATH, HOME and the rest of a
 * normal environment. But these particular names are the engine's SAFETY surface — its
 * control plane, its bearer, its tier, and the switch that runs mutating tools with no
 * confirmation at all. Inheriting them means whatever is exported in the shell that
 * launched Electron silently outranks what Daintree decided: a stale `DAINTREE_MCP_URL`
 * survives a provisioning failure and points the engine at a dead endpoint, and an
 * ambient `DAINTREE_ASSISTANT_AUTO_APPROVE=1` turns approvals off for a user whose
 * settings say otherwise. Every one of them is re-set below from an authoritative
 * source, or deliberately left unset.
 */
const ENGINE_CONTROLLED_ENV = [
  "DAINTREE_MCP_URL",
  "DAINTREE_MCP_TOKEN",
  "DAINTREE_ASSISTANT_TIER",
  "DAINTREE_ASSISTANT_AUTO_APPROVE",
  "DAINTREE_ASSISTANT_DEBUG_LOG",
  "DAINTREE_ASSISTANT_LOG_DIR",
  "DAINTREE_PROJECT_ID",
  "DAINTREE_WINDOW_ID",
] as const;

/** Where native-engine debug logs are written. Daintree-owned, beside its other data. */
function assistantLogDir(): string {
  return path.join(app.getPath("userData"), "assistant-logs");
}

/**
 * Daintree's Help tier → the engine's own tier vocabulary.
 *
 * Two separate ladders that happen to share one name. The engine defaults an UNSET
 * tier to its widest (`system`), so failing to map this is not a missing feature — it
 * silently runs every native session at maximum authority regardless of what the
 * user's assistant settings say.
 */
function engineTierFor(helpTier: string): string {
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

/** The environment a child engine starts with, with inherited control vars removed. */
function baseEngineEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if ((ENGINE_CONTROLLED_ENV as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  return env;
}

export class AssistantHostService {
  /** projectId → live session. The one-per-project rule lives in this keying. */
  private readonly byProject = new Map<string, LiveSession>();
  /** sessionId → live session, for command routing. */
  private readonly bySession = new Map<string, LiveSession>();
  /** projectId → tail of the in-flight start chain. See `start`. */
  private readonly startQueue = new Map<string, Promise<unknown>>();

  /**
   * Starts an engine for a project, displacing any existing one.
   *
   * Resolution failures are thrown rather than swallowed: the message from
   * `resolveAssistantBinary` names the actual fix (check out the submodule, build the
   * engine), and a silent failure here would present as an assistant that simply
   * never answers.
   */
  async start(opts: StartSessionOptions): Promise<AssistantHostStartResult> {
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
    let mcp: { url: string | null; token: string; tier: string } | null = null;
    let mcpUnavailableReason: string | null = null;
    let debugLogging = false;
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
        mcp = { url: provisioned.mcpUrl, token: provisioned.token, tier: provisioned.tier };
        debugLogging = helpSessionService.getDebugLogging(provisioned.token);
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
        tier: opts.tier ?? "system",
        protocolVersion: ASSISTANT_HOST_PROTOCOL_VERSION,
      },
      env: {
        // Inherited MINUS the control variables — see ENGINE_CONTROLLED_ENV.
        ...baseEngineEnv(),
        DAINTREE_BACKEND_URL: resolveBackendUrl(process.env.DAINTREE_BACKEND_URL),
        // Nothing from the renderer reaches here, deliberately: a renderer-supplied
        // bag would let a compromised view repoint the engine or hand itself standing
        // approval. Secrets are provisioned in main, next to the service issuing them.
        DAINTREE_PROJECT_ID: opts.projectId,
        DAINTREE_WINDOW_ID: String(opts.windowId),
        // The tier the SETTINGS decided, mapped into the engine's vocabulary — not the
        // renderer's requested tier, which only ever reaches the descriptor.
        DAINTREE_ASSISTANT_TIER: engineTierFor(mcp?.tier ?? "workbench"),
        // Debug logging, from the same assistant setting the PTY path reads. Both
        // halves are required — the engine writes nothing unless it has a flag AND a
        // directory — which is why the native path produced no log at all until now,
        // and why a session that misbehaves had no trace to read afterwards. The
        // directory is Daintree-owned so the logs sit with the rest of the app's data
        // rather than in the engine's own home.
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

    const session: LiveSession = {
      sessionId,
      projectId: opts.projectId,
      host,
      webContentsId: opts.webContentsId,
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

  /** Tears down every session (app shutdown). */
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

  /** True when `sessionId` is a live session owned by `webContentsId`. */
  isOwnedBy(sessionId: string, webContentsId: number): boolean {
    return this.bySession.get(sessionId)?.webContentsId === webContentsId;
  }
}

export const assistantHostService = new AssistantHostService();

/** Re-exported for the IPC layer's typing. */
export type { AssistantHostEvent };

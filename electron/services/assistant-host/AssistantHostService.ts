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
 * `DAINTREE_BACKEND_URL` moves it, but only within loopback — see `resolveBackendUrl`.
 * Change this constant when the native panel is ready to face the deployed backend by
 * default.
 */
const DEFAULT_BACKEND_URL = "http://127.0.0.1:8473";

/** Hostnames that mean "this machine". `[::1]` arrives bracketed from a URL. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Whether a URL hostname names this machine.
 *
 * Read AFTER the URL parser, which is what makes this safe to do by name: WHATWG
 * normalises the IPv4 shorthands an allowlist would otherwise have to know about
 * (`http://2130706433/` and `http://0x7f000001/` both arrive here as `127.0.0.1`), and
 * it puts userinfo where it belongs — `http://127.0.0.1@evil.test/` has hostname
 * `evil.test`, so the oldest trick in this family is answered by asking the parser
 * rather than by matching the string.
 *
 * The whole 127.0.0.0/8 block counts, not just `.1`: binding a second local backend on
 * `127.0.0.2` is an ordinary thing to do and there is no reason to refuse it. Anything
 * this does not recognise — a trailing-dot FQDN, an IPv4-mapped IPv6 literal — is
 * REFUSED rather than guessed at. Refusing is a fallback to the default, so the cost of
 * being wrong in that direction is an inconvenience, and in the other it is a prompt
 * leaving the machine.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // A trailing dot is the same name, absolutely qualified.
  if (host.endsWith(".") && LOOPBACK_HOSTS.has(host.slice(0, -1))) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 127;
}

/**
 * The backend endpoint for a spawned engine — LOOPBACK ONLY.
 *
 * An override still wins for the parts that are a developer's business: the port, the
 * scheme, a path prefix. What it cannot do is leave the machine. The native panel is
 * pre-release and unauthenticated, and every prompt, file path and command it carries
 * goes to whatever this names — so a stray `DAINTREE_BACKEND_URL` exported in a shell
 * months ago, or inherited from a parent process, must not be able to silently route
 * that off-box. Loopback is the pin; the override moves it around inside the pin.
 *
 * A rejected value falls back to the default rather than failing the launch. The
 * assistant still works, on the backend it was always supposed to use, and the reason
 * is on the console — which is the right trade for a setting nobody deliberately aimed
 * off-box in the first place.
 *
 * A blank value is treated as ABSENT rather than passed through. The engine reads an
 * empty `DAINTREE_BACKEND_URL` as unset and falls through to the stored `/backend`
 * preference and then to its own deployed default, so forwarding `""` would quietly
 * undo the pin — and do it on the one input a shell most easily produces.
 */
export function resolveBackendUrl(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_BACKEND_URL;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Unparseable is not a deliberate override — it is a typo, and passing it through
    // lands the engine on its deployed default, which is the one outcome to avoid.
    console.warn(
      `[assistant-host] Ignoring unparseable DAINTREE_BACKEND_URL ${JSON.stringify(trimmed)}; using ${DEFAULT_BACKEND_URL}.`
    );
    return DEFAULT_BACKEND_URL;
  }
  if (!isLoopbackHost(parsed.hostname)) {
    console.warn(
      `[assistant-host] DAINTREE_BACKEND_URL points off-box (${parsed.hostname}); the assistant is loopback-only while it is unauthenticated. Using ${DEFAULT_BACKEND_URL}.`
    );
    return DEFAULT_BACKEND_URL;
  }
  // The NORMALISED serialisation, not the string we were handed.
  //
  // Two runtimes read this value and they do not agree on the exotic spellings.
  // `http://2130706433/` is loopback to the WHATWG parser used above, which resolves it
  // to 127.0.0.1 — but Go's `net.ParseIP` does not recognise the decimal form at all, so
  // the engine's own "is this loopback?" check says no and its client is free to send
  // the request through an inherited `HTTP_PROXY`. Validated here, refused off-box, and
  // then quietly proxied off-box anyway. Handing on the canonical form closes that gap:
  // both parsers see the same address.
  return parsed.href;
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
  // The engine's UPSTREAM credential (internal/config/config.go), sent as the backend
  // bearer. There is no sign-in here and Daintree mints nothing, so the only way this
  // can be set is by inheritance — and an inherited key does not fail, it succeeds:
  // turns go through, billed to whoever the key belongs to, with nothing on screen to
  // say the session stopped being anonymous. Stripped and never re-set, which is what
  // "zero authentication" has to mean if it is to mean anything.
  "DAINTREE_API_KEY",
  // The endpoint. Not inherited raw — `resolveBackendUrl` decides it below, and letting
  // the parent's value through would sit in the environment beside the resolved one.
  "DAINTREE_BACKEND_URL",
] as const;

/**
 * Names to strip, upper-cased once.
 *
 * Windows environment variables are case-INSENSITIVE: a parent that exported
 * `daintree_assistant_auto_approve=1` reaches `process.env` under that spelling, an
 * exact-match filter keeps it, and the child then reads it under any casing. The one
 * variable where that matters most is the one that turns off every confirmation.
 */
const ENGINE_CONTROLLED_ENV_UPPER = new Set<string>(
  ENGINE_CONTROLLED_ENV.map((name) => name.toUpperCase())
);

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
    if (ENGINE_CONTROLLED_ENV_UPPER.has(key.toUpperCase())) continue;
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
        mcp = { url: provisioned.mcpUrl, token: provisioned.token, tier: provisioned.tier };
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

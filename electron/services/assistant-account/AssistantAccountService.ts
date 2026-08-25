import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { z } from "zod";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { resolveAssistantBinary } from "../assistant-host/resolveAssistantBinary.js";
import { resolveBackendUrl } from "../assistant-host/resolveBackendUrl.js";
import { assistantChildEnv } from "../assistant-host/assistantChildEnv.js";
import { getHelpAssistantSettings } from "../../ipc/handlers/helpAssistant.js";
import type { AssistantBackendEnvironment } from "../../../shared/config/assistantBackend.js";
import type {
  AssistantAccountLoginProgress,
  AssistantAccountLoginResult,
  AssistantAccountStatus,
  AssistantAccountStatusOptions,
  AssistantAccountStatusResult,
} from "../../../shared/types/ipc/assistantAccount.js";

/**
 * The exact child shape this service spawns: stdin IGNORED, stdout and stderr piped.
 *
 * Typed precisely rather than as ChildProcessWithoutNullStreams because stdin genuinely
 * IS null here, and that is the point — there is no channel for a credential to arrive
 * on, and the type now says so.
 */
type AccountChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Drives the assistant CLI's account commands from the main process.
 *
 * Daintree implements no part of sign-in. The CLI owns the credential — it is the only
 * process that touches the OS keychain, refreshes a rotating token, and coordinates that
 * across the modes it runs in (a terminal, the embedded host, a per-project supervisor
 * daemon that keeps working after this window closes). If Electron held the refresh token
 * instead, every one of those modes would either stop working or need raw credentials
 * copied through environment variables and IPC — which is exactly how a rotating secret
 * ends up in a process listing.
 *
 * So this service shells out and renders. Three rules follow from that, and all three are
 * load-bearing:
 *
 *  - It reads the CLI's `--json` event stream from STDOUT and nothing else. Human
 *    diagnostics go to stderr precisely so a stray sentence cannot corrupt the stream.
 *  - It never places a token in an argument, an environment variable, a log line or an
 *    IPC payload, because it never HAS one: the CLI reports state, never credentials.
 *  - One login at a time, pinned to the window that started it. A second window observes
 *    the active attempt rather than opening a competing browser flow against the CLI's
 *    single fixed callback port.
 */

/** How long a status call may take. Short: it is a local process reading a keychain. */
const STATUS_TIMEOUT_MS = 10_000;

/**
 * How long a REFRESHING status call may take.
 *
 * Sized to sit ABOVE the CLI's own worst case rather than to feel snappy, because killing
 * this particular operation early is not a harmless timeout. A refresh runs a sequence
 * that is individually bounded but additive — manifest discovery (10s), the cross-process
 * credential lock (30s), the keyring read (20s), the token request (30s), then persisting
 * the rotated credential. Cutting it off partway can land exactly between the provider
 * spending the old one-time-use refresh token and the new one reaching the keychain,
 * which does not show a timeout: it signs the user out.
 *
 * So the CLI is allowed to finish and report its own failure. This bound exists only to
 * stop a wedged child living forever.
 */
const REFRESH_TIMEOUT_MS = 150_000;

/** A login waits on a human in a browser. The CLI's own deadline is five minutes. */
const LOGIN_TIMEOUT_MS = 6 * 60_000;

/** Bounds one stdout stream, so a wedged child cannot grow unboundedly in memory. */
const MAX_STREAM_BYTES = 1 << 20;

/** How long a terminated child has to exit before it is killed outright. */
const TERMINATE_GRACE_MS = 3_000;

/**
 * How long shutdown waits for an account child before signalling it.
 *
 * Shorter than `TERMINATE_GRACE_MS` on purpose. That budget is for a running app, where
 * waiting costs nothing anyone notices. This one is spent inside Electron's ten-second
 * main-process cleanup window, alongside everything else that has to finish before the
 * app dies — and these are short-lived CLI commands, so a child that has not gone in
 * two seconds is one that is not going to.
 */
const SHUTDOWN_GRACE_MS = 2_000;

/** One NDJSON line may not exceed this. Longer is not a login event. */
const MAX_LINE_BYTES = 64 << 10;

/**
 * The event shape the CLI emits under `--json`.
 *
 * Validated rather than trusted, even though we spawn the binary ourselves: a mismatched
 * build is the ordinary case during a rollout, and a malformed line must be dropped
 * rather than rendered.
 */
const cliEventSchema = z.object({
  v: z.number(),
  type: z.string(),
  environment: z.string().optional(),
  url: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  data: z.unknown().optional(),
});

/** The status payload, as `auth status --json` reports it. */
const statusSchema = z.object({
  // Closed enums, so an unrecognised value is REJECTED rather than cast into a union it
  // is not a member of. A renderer switching on `state` would otherwise fall through
  // every case and render nothing.
  state: z.enum([
    "unknown",
    "signed_out",
    "authorizing",
    "signed_in_unverified",
    "signed_in_active",
    "signed_in_subscription_required",
    "signed_in_subscription_inactive",
    "refreshing",
    "temporarily_unavailable",
    "revoked",
    "storage_unavailable",
  ]),
  authenticated: z.boolean().optional(),
  environment: z.string().optional(),
  backendUrl: z.string().optional(),
  email: z.string().optional(),
  subjectHash: z.string().optional(),
  planId: z.string().optional(),
  entitlementSource: z.string().optional(),
  entitlementStale: z.boolean().optional(),
  usageRemaining: z.string().optional(),
  accessExpiresAt: z.string().optional(),
  sessionMaxAgeSeconds: z.number().optional(),
  storageTier: z.enum(["keychain", "memory", "unavailable"]).optional(),
  // Tri-state: absent means the engine did not say. Never defaulted here — a default
  // would turn "unknown" into a definite answer at the boundary, which is precisely the
  // decision the renderer has to make for itself.
  authRequired: z.boolean().optional(),
  lastVerifiedAt: z.string().optional(),
  lastErrorCode: z.string().optional(),
  links: z.object({ account: z.string().optional(), subscribe: z.string().optional() }).optional(),
  authRevision: z.string().optional(),
});

/**
 * Strips a URL down to what is safe to hand a renderer.
 *
 * The types say no field here can carry a credential; nothing ENFORCED that, and the
 * claim was therefore untrue. A `browser_opened.url` of
 * `https://idp.example/authorize?...&state=SECRET` validated fine and was forwarded
 * verbatim — precisely the value the whole design keeps off this channel.
 *
 * So the origin and path survive and everything else does not: query strings and
 * fragments are where OAuth puts state, codes and tokens, and userinfo is a credential
 * outright. A non-HTTPS URL is dropped entirely rather than sanitised, because nothing
 * legitimate on this path is anything else.
 */
function safeExternalUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:") return undefined;
  u.search = "";
  u.hash = "";
  u.username = "";
  u.password = "";
  return u.toString();
}

/**
 * Electron-owned copy for a stable account error code.
 *
 * Deliberately not the CLI's own message: that text can quote an identity provider, and
 * provider error strings are attacker-influenced. A code we recognise gets a sentence we
 * wrote; anything else gets a generic one.
 */
function accountErrorCopy(code: string | undefined): string {
  switch (code) {
    case "auth_callback_port_in_use":
      return "The sign-in callback port is already in use. Close the other process and try again.";
    case "auth_interactive_environment_required":
      return "Signing in needs a browser on this machine.";
    case "auth_discovery_unavailable":
      return "Could not reach the assistant backend to start sign-in.";
    case "auth_discovery_invalid":
      return "The backend described a sign-in configuration this build will not use.";
    case "auth_accounts_unavailable":
      return "This backend doesn't use accounts, so there's nothing to sign in to.";
    case "auth_state_mismatch":
      return "That sign-in response did not match this attempt. Try again.";
    case "auth_timeout":
      return "Sign-in timed out waiting for the browser.";
    case "auth_storage_unavailable":
      return "No system credential store is available, so the sign-in cannot be saved.";
    default:
      return "Sign-in did not complete.";
  }
}

/** The supported protocol version of the CLI's event stream. */
const SUPPORTED_EVENT_VERSION = 1;

/**
 * The literal the CLI's help must contain for the account commands to exist.
 *
 * THIS GATE IS NOT OPTIONAL, and the reason is specific and expensive. The CLI routes a
 * positional subcommand only when `--json` is absent — with it, a positional is a PROMPT.
 * So on an engine that predates the account commands, `auth status --json` does not fail:
 * it runs a real, billed model turn whose prompt is the words "auth status", and
 * `auth logout --json` runs one whose prompt is "auth logout" and then exits 0, which
 * this service would have reported as a successful sign-out.
 *
 * Daintree vendors the CLI as a submodule, so shipping a build whose pin predates the
 * feature is the ORDINARY case during rollout, not an edge one. Probing help costs one
 * cheap local exec and is unambiguous: an older binary's help has no such line.
 */
const AUTH_CAPABILITY_MARKER = "auth <action>";

export interface AssistantAccountServiceOptions {
  /** Overrides binary resolution; for tests. */
  resolveBinary?: () => Promise<string>;
  /** Overrides process spawning; for tests. */
  spawnProcess?: typeof spawn;
  /**
   * Overrides the stored environment choice; for tests.
   *
   * Injected rather than read directly so this service can be exercised without the
   * settings store — and so a test can prove the resolved endpoint reaches the child,
   * which is the property that was missing entirely.
   */
  resolveEnvironment?: () => AssistantBackendEnvironment | undefined;
}

export class AssistantAccountService {
  private readonly resolveBinary: () => Promise<string>;
  private readonly spawnProcess: typeof spawn;
  private readonly resolveEnvironment: () => AssistantBackendEnvironment | undefined;

  /**
   * The single in-flight login, if any.
   *
   * `child` is null while the binary is still being resolved. The slot is RESERVED
   * synchronously before the first await, because two callers could otherwise both see
   * it empty, both suspend in resolveBinary, and both spawn — against a CLI that binds
   * one fixed callback port, leaving the loser's browser tab unable ever to complete.
   */
  private activeLogin: {
    id: number;
    child: AccountChild | null;
    webContentsId: number;
    cancelRequested: boolean;
  } | null = null;

  private nextLoginId = 1;

  /** The most recent attempt a caller explicitly cancelled. */
  private lastCancelledAttempt = 0;

  /** Whether the engine has account commands. Null until probed. */
  private authSupported: boolean | null = null;

  /**
   * Children with a termination already in progress.
   *
   * A `WeakSet` so a child that exits and is dropped takes its entry with it — this is
   * bookkeeping about a live process, not a record worth outliving one.
   */
  private readonly terminating = new WeakSet<AccountChild>();

  /**
   * Every account child that has been spawned and has not yet closed.
   *
   * Not just the login. `auth status --refresh` is allowed 150 seconds and `auth
   * logout` its own bound, and a quit landing inside one of those leaves a process
   * talking to a backend on behalf of an app that no longer exists. The login is the
   * one that HURTS — it holds the CLI's single fixed callback port — but "no child
   * survives its owner" is not a rule with exceptions for the quick ones.
   */
  private readonly liveChildren = new Set<AccountChild>();

  constructor(opts: AssistantAccountServiceOptions = {}) {
    this.resolveBinary = opts.resolveBinary ?? (() => resolveAssistantBinary());
    this.spawnProcess = opts.spawnProcess ?? spawn;
    this.resolveEnvironment =
      opts.resolveEnvironment ?? (() => getHelpAssistantSettings().backendEnvironment);
  }

  /**
   * The environment every account command runs in.
   *
   * This is the fix for a real divergence rather than a tidy-up. These commands used to
   * spawn with no `env` at all, so they inherited whatever the shell that launched
   * Electron happened to export — while the ENGINE was spawned with an explicitly
   * resolved `DAINTREE_BACKEND_URL`. The two could therefore disagree, and the shape of
   * the disagreement was the bad one: `auth status` would report a healthy account on
   * one backend while every turn ran against another, with nothing on either side
   * saying so.
   *
   * Resolved per spawn, not cached, so switching environments in Settings takes effect
   * on the next command rather than the next launch.
   */
  private commandEnv(): NodeJS.ProcessEnv {
    return {
      // The SAME stripping the engine spawn gets, from the same list. Spreading
      // `process.env` whole was the remaining half of a bug this service already fixed
      // once: the engine was denied an ambient `DAINTREE_API_KEY` — an upstream
      // credential Daintree does not mint and cannot see — while `auth status`, the
      // command whose entire job is reporting who you are signed in as, inherited it.
      // The variable is stripped and never re-set, which is what "Daintree holds no
      // credential" has to mean if it is to mean anything.
      //
      // `DAINTREE_BACKEND_URL` is stripped by that list too, case-insensitively, and
      // then re-added below from the resolver. That ordering matters on Windows, where
      // environment names are case-insensitive: without it an inherited
      // `daintree_backend_url` would sit beside the resolved one and the child would be
      // free to read either.
      ...assistantChildEnv(),
      DAINTREE_BACKEND_URL: resolveBackendUrl(
        process.env.DAINTREE_BACKEND_URL,
        this.resolveEnvironment()
      ),
    };
  }

  /** Reports whether a login is currently running. */
  isLoginInProgress(): boolean {
    return this.activeLogin !== null;
  }

  /**
   * Confirms the engine actually has account commands, caching the answer.
   *
   * Called before EVERY auth invocation. Guessing from an exit code is not good enough —
   * see AUTH_CAPABILITY_MARKER: on an older engine the commands do not fail, they run as
   * billed model prompts.
   */
  private async supportsAuth(bin: string): Promise<boolean> {
    if (this.authSupported !== null) return this.authSupported;
    const help = await this.runToCompletion(bin, ["--help"], STATUS_TIMEOUT_MS);
    const supported = !help.timedOut && help.stdout.includes(AUTH_CAPABILITY_MARKER);
    this.authSupported = supported;
    return supported;
  }

  /**
   * Reads the account status. Never mutates anything.
   *
   * `refresh` forces the CLI to re-verify against the backend instead of answering from
   * what it already has on disk. It is the difference between "what did we last know"
   * and "what is true now", and only the second one is any use immediately after a
   * checkout.
   */
  async getStatus(
    options: AssistantAccountStatusOptions = {}
  ): Promise<AssistantAccountStatusResult> {
    let bin: string;
    try {
      bin = await this.resolveBinary();
    } catch (err) {
      return {
        available: false,
        reason: "cli-missing",
        message: formatErrorMessage(err, "The assistant engine could not be located."),
      };
    }

    if (!(await this.supportsAuth(bin))) {
      return {
        available: false,
        reason: "cli-too-old",
        message: "This build's assistant engine does not support accounts yet.",
      };
    }

    const args = ["auth", "status", "--json"];
    if (options.refresh) args.push("--refresh");
    // A refresh reaches the network, so it gets the longer bound. Charging a remote
    // round trip against the local-read timeout would report a working backend as a
    // timed-out CLI.
    const run = await this.runToCompletion(
      bin,
      args,
      options.refresh ? REFRESH_TIMEOUT_MS : STATUS_TIMEOUT_MS
    );
    if (run.timedOut) {
      return {
        available: false,
        reason: "timeout",
        message: "The assistant did not answer in time.",
      };
    }
    // Exit 2 is the CLI's argument error. During a rollout that is overwhelmingly a
    // build whose vendored engine predates the `auth` command, and saying so is the
    // difference between "update Daintree" and someone debugging a sign-in that the
    // binary has never heard of.
    if (run.code === 2 || /unknown|unrecognized|flag provided/i.test(run.stderr)) {
      return {
        available: false,
        reason: "cli-too-old",
        message: "This build's assistant engine does not support accounts yet.",
      };
    }

    const status = this.parseStatus(run.stdout);
    if (!status) {
      return {
        available: false,
        reason: "cli-failed",
        message: "The assistant returned an account status this build could not read.",
      };
    }
    // Exit 3 means "not signed in", which is a STATE and not a failure.
    return { available: true, status };
  }

  /**
   * Runs an interactive login, forwarding progress to the initiating window only.
   *
   * `onProgress` is called with validated events. It never receives the authorization
   * URL: that value carries a live PKCE-bound request, and the CLI deliberately keeps it
   * off the event stream for exactly this reason — it reaches the user through the
   * browser the CLI opens, and nowhere else.
   */
  async login(
    webContentsId: number,
    onProgress: (event: AssistantAccountLoginProgress) => void
  ): Promise<AssistantAccountLoginResult> {
    if (this.activeLogin) {
      // A second window observes the active attempt rather than starting a competing
      // one. The CLI binds ONE fixed callback port, so two concurrent flows leave the
      // loser staring at a browser tab that can never complete.
      return {
        signedIn: false,
        cancelled: false,
        code: "login_in_progress",
        message: "A sign-in is already in progress.",
      };
    }
    // RESERVED SYNCHRONOUSLY, before the first await. Setting it after resolveBinary
    // leaves a window in which both callers pass the check above.
    const attemptId = this.nextLoginId++;
    this.activeLogin = { id: attemptId, child: null, webContentsId, cancelRequested: false };
    // Clears the slot only if THIS attempt still owns it, so a late completion cannot
    // release a newer one.
    const releaseSlot = () => {
      if (this.activeLogin?.id === attemptId) this.activeLogin = null;
    };

    let bin: string;
    try {
      bin = await this.resolveBinary();
    } catch (err) {
      releaseSlot();
      return {
        signedIn: false,
        cancelled: false,
        code: "cli-missing",
        message: formatErrorMessage(err, "The assistant engine could not be located."),
      };
    }
    if (!(await this.supportsAuth(bin))) {
      releaseSlot();
      return {
        signedIn: false,
        cancelled: false,
        code: "cli-too-old",
        message: "This build's assistant engine does not support accounts yet.",
      };
    }

    // Cancellation is checked HERE, immediately before spawning, and not only at the
    // top. The slot is reserved before the first await, so a Cancel — or the owning
    // window going away — that arrives while the binary is still being resolved sets
    // `cancelRequested` against a login whose `child` is still null. `terminate` has
    // nothing to kill, and the code then spawned anyway: a browser tab opens for a
    // sign-in nobody asked for any more, holding the CLI's one fixed callback port
    // until it times out five minutes later.
    if (this.activeLogin?.id !== attemptId || this.activeLogin.cancelRequested) {
      releaseSlot();
      return { signedIn: false, cancelled: true, message: "Sign-in was cancelled." };
    }

    const child = this.spawnProcess(bin, ["auth", "login", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: this.commandEnv(),
    }) as AccountChild;
    this.track(child);

    if (this.activeLogin?.id === attemptId) this.activeLogin.child = child;

    return new Promise<AssistantAccountLoginResult>((resolve) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let sawAuthenticated = false;
      let notOffered = false;
      let cancelled = false;
      const cancelRequestedFor = (id: number) => this.lastCancelledAttempt === id;
      let lastError: { code?: string; message?: string } | null = null;

      const finish = (result: AssistantAccountLoginResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        releaseSlot();
        resolve(result);
      };

      const timer = setTimeout(() => {
        this.terminate(child);
        finish({
          signedIn: false,
          cancelled: false,
          code: "timeout",
          message: "Sign-in timed out.",
        });
      }, LOGIN_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        let idx: number;
        while ((idx = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, idx);
          stdout = stdout.slice(idx + 1);
          const event = this.parseEvent(line);
          if (!event) continue;
          if (event.type === "authenticated") sawAuthenticated = true;
          if (event.type === "not_offered") notOffered = true;
          if (event.type === "cancelled") cancelled = true;
          if (event.type === "error") lastError = { code: event.code, message: event.message };
          onProgress(event);
        }
        // Drop an over-long UNTERMINATED remainder rather than returning early on a
        // full buffer. The early return wedged the parser for good: once the buffer
        // passed the cap, every later chunk — including the newline that would have
        // completed the line, and every valid event after it — was discarded, so a
        // successful login reported as a failure.
        if (stdout.length > MAX_LINE_BYTES) stdout = "";
      });

      // stderr is READ but never forwarded. It carries human diagnostics, and on the
      // --no-open path it can carry the authorization URL itself — which must not reach
      // a renderer. Kept only to bound the buffer and to diagnose a spawn failure.
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < MAX_STREAM_BYTES) stderr += chunk;
      });

      child.on("error", (err) => {
        finish({ signedIn: false, cancelled: false, code: "spawn_failed", message: err.message });
      });

      child.on("close", (code) => {
        // A cancel we requested arrives as a signal-only close with no "cancelled"
        // event, so the flag has to be consulted too — otherwise pressing Cancel
        // reports "Sign-in did not complete", which reads as a fault rather than a
        // choice the user just made.
        if (cancelled || this.activeLogin?.id !== attemptId || cancelRequestedFor(attemptId)) {
          finish({ signedIn: false, cancelled: true, message: "Sign-in was cancelled." });
          return;
        }
        if (code === 0 && sawAuthenticated) {
          finish({ signedIn: true });
          return;
        }
        // Exit ZERO with no sign-in, because there was nothing to sign in to. Checked
        // before the generic tail below, which would otherwise report "Sign-in did not
        // complete" — a fault — for a backend working exactly as intended. The exit code
        // is part of the condition: a run that emitted this and then failed for some
        // other reason is a failure, and must not be reported as nothing-to-do.
        if (code === 0 && notOffered) {
          finish({
            signedIn: false,
            cancelled: false,
            code: "auth_accounts_unavailable",
            message: accountErrorCopy("auth_accounts_unavailable"),
          });
          return;
        }
        if (code === 2) {
          finish({
            signedIn: false,
            cancelled: false,
            code: "cli-too-old",
            message: "This build's assistant engine does not support accounts yet.",
          });
          return;
        }
        finish({
          signedIn: false,
          cancelled: false,
          code: lastError?.code,
          message: lastError?.message ?? "Sign-in did not complete.",
        });
      });
    });
  }

  /**
   * Cancels an in-flight login started by this window.
   *
   * Scoped to the owning view on purpose: one window must not be able to cancel
   * another's sign-in, and a window that closes should take its own attempt with it.
   */
  cancelLogin(webContentsId: number): boolean {
    const active = this.activeLogin;
    if (!active || active.webContentsId !== webContentsId) return false;
    active.cancelRequested = true;
    this.lastCancelledAttempt = active.id;
    this.terminate(active.child);
    return true;
  }

  /**
   * Reaps a login owned by a view that has gone away.
   *
   * Called when a window is destroyed. Without it a sign-in outlives the window that
   * asked for it: the CLI sits waiting on a browser callback for its full five minutes,
   * holding the one fixed port, so the next window's sign-in collides with a flow nobody
   * can see or complete.
   */
  disposeForWebContents(webContentsId: number): void {
    if (this.activeLogin?.webContentsId === webContentsId) {
      this.cancelLogin(webContentsId);
    }
  }

  /** Records a spawned child until it closes, so shutdown can find it. */
  private track(child: AccountChild): void {
    this.liveChildren.add(child);
    child.once("close", () => this.liveChildren.delete(child));
  }

  /**
   * Reaps any sign-in at all, whoever owns it. For app shutdown.
   *
   * Not the same call as `disposeForWebContents`: at quit there is no particular owner
   * to name, and the thing that matters is that no `auth login` is left waiting on a
   * browser callback for its full five-minute timeout, holding the CLI's one fixed
   * callback port, after the app it belonged to has gone.
   */
  disposeAll(): void {
    const active = this.activeLogin;
    if (active) {
      active.cancelRequested = true;
      this.lastCancelledAttempt = active.id;
    }
    for (const child of [...this.liveChildren]) this.terminate(child);
  }

  /**
   * Reaps every account child and WAITS for it, bounded. For app shutdown.
   *
   * `disposeAll` on its own is not enough at quit, and the reason is the same one the
   * engine has: termination sends SIGTERM and arms an UNREF'D SIGKILL backstop, which
   * is right while the app is running and worthless once `app.exit()` is on its way —
   * `app.exit()` takes the timer with it, and a spawned child is not reaped with its
   * parent. So the escalation has to happen while there is still a process here to
   * escalate. A `login` sitting on the CLI's one fixed callback port is the case that
   * matters: left alive it blocks the next install's sign-in from completing at all.
   */
  async shutdown(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    const children = [...this.liveChildren];
    this.disposeAll();
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            let done = false;
            const settle = () => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                // Exited between the timer firing and this call.
              }
              settle();
            }, graceMs);
            timer.unref?.();
            child.once("close", settle);
          })
      )
    );
  }

  /**
   * Terminates a child and makes sure it actually dies. Idempotent per child.
   *
   * SIGTERM alone is a request. A child that ignores it — or that is blocked in a
   * syscall — stays alive holding the callback port, so a bounded SIGKILL follows.
   *
   * Three things here are load-bearing and none of them is obvious:
   *
   *  - An ALREADY-EXITED child is returned on before anything is armed. `kill()` on a
   *    reaped process returns `false`; it does not throw, so the old `try/catch` did not
   *    catch it. The backstop was armed anyway and its `close` listener was attached
   *    after `close` had already fired, so the timer was never cleared — a five-second
   *    hold on the event loop for a process that was gone before we were called.
   *    `child.killed` is NOT the test for this: it means a signal was sent, not that
   *    anything exited.
   *  - The cleanup is registered BEFORE the signal, because a child can exit between
   *    the two lines.
   *  - The backstop is unref'd. It exists to reap a child, not to keep the app alive
   *    long enough to do it while the user is trying to quit.
   */
  private terminate(child: AccountChild | null): void {
    if (!child) return;
    // Already reaped — nothing to signal, and nothing to arm.
    if (child.exitCode !== null || child.signalCode !== null) return;
    // A second Cancel, or a cancel racing the timeout, would otherwise stack another
    // timer and another listener on the same child.
    if (this.terminating.has(child)) return;
    this.terminating.add(child);

    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited between the timer firing and this call.
      }
    }, TERMINATE_GRACE_MS);
    killTimer.unref?.();
    child.once("close", () => {
      clearTimeout(killTimer);
      this.terminating.delete(child);
    });

    try {
      child.kill("SIGTERM");
    } catch {
      // Gone between the exit check above and here. The listener registered above
      // still clears the backstop when `close` arrives.
    }
  }

  /** Signs out on this machine. */
  async logout(): Promise<{ signedOut: boolean; message?: string }> {
    let bin: string;
    try {
      bin = await this.resolveBinary();
    } catch (err) {
      return {
        signedOut: false,
        message: formatErrorMessage(err, "The assistant engine could not be located."),
      };
    }
    if (!(await this.supportsAuth(bin))) {
      // The worst of the three on an old engine: "auth logout" would run as a prompt,
      // exit 0, and be reported as a successful sign-out that never happened.
      return {
        signedOut: false,
        message: "This build's assistant engine does not support accounts yet.",
      };
    }

    const run = await this.runToCompletion(bin, ["auth", "logout", "--json"], STATUS_TIMEOUT_MS);
    if (run.timedOut) return { signedOut: false, message: "Sign-out did not complete in time." };
    if (run.code !== 0) {
      return { signedOut: false, message: "Sign-out failed." };
    }
    return { signedOut: true };
  }

  /** Parses one NDJSON line into a progress event, or null when it is not one. */
  private parseEvent(line: string): AssistantAccountLoginProgress | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return null;
    }
    const parsed = cliEventSchema.safeParse(raw);
    if (!parsed.success) return null;
    // An unknown future version is DROPPED rather than guessed at. Rendering a payload
    // whose meaning has changed is worse than rendering nothing.
    if (parsed.data.v !== SUPPORTED_EVENT_VERSION) return null;

    const suffix = parsed.data.type.startsWith("auth:")
      ? parsed.data.type.slice("auth:".length)
      : parsed.data.type;

    switch (suffix) {
      case "starting":
        return { type: "starting", environment: parsed.data.environment };
      case "browser_opened":
        // The CLI publishes only a safe account origin here — but this strips the URL
        // anyway rather than trusting that. A field the renderer receives should be safe
        // because THIS process made it so, not because another one promised.
        return { type: "browser_opened", url: safeExternalUrl(parsed.data.url) };
      case "waiting": {
        const d = parsed.data.data as { callback?: unknown; timeoutSeconds?: unknown } | undefined;
        return {
          type: "waiting",
          callback: typeof d?.callback === "string" ? d.callback : undefined,
          timeoutSeconds: typeof d?.timeoutSeconds === "number" ? d.timeoutSeconds : undefined,
        };
      }
      case "authenticated":
        return { type: "authenticated" };
      case "cancelled":
        return { type: "cancelled" };
      case "not_offered":
        return { type: "not_offered" };
      case "error": {
        // The CODE is the contract; the message is prose from another process that may
        // itself be quoting an identity provider. Rendering our own copy keyed by the
        // code means nothing upstream can put arbitrary text — or a value it failed to
        // redact — on a Daintree surface.
        const code = parsed.data.code;
        return { type: "error", code, message: accountErrorCopy(code) };
      }
      default:
        // An unrecognised type is ignored, so an additive CLI change does not break a
        // login on an older Daintree.
        return null;
    }
  }

  /** Parses the status document out of a `auth status --json` run. */
  private parseStatus(stdout: string): AssistantAccountStatus | null {
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        continue;
      }
      // The status rides inside a versioned event, like every other line — and the
      // version is CHECKED here as it is for progress. Without it a future v99 payload,
      // or a state string this build has no case for, reached the renderer cast into a
      // union it does not actually belong to.
      const asEvent = cliEventSchema.safeParse(raw);
      if (!asEvent.success) continue;
      if (asEvent.data.v !== SUPPORTED_EVENT_VERSION) continue;
      if (asEvent.data.type !== "auth:status") continue;
      const candidate = asEvent.data.data;
      const parsed = statusSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const d = parsed.data;
      return {
        state: d.state,
        authenticated: d.authenticated ?? false,
        environment: d.environment,
        backendUrl: d.backendUrl,
        email: d.email,
        subjectHash: d.subjectHash,
        planId: d.planId,
        entitlementSource: d.entitlementSource,
        entitlementStale: d.entitlementStale,
        usageRemaining: d.usageRemaining,
        accessExpiresAt: d.accessExpiresAt,
        sessionMaxAgeSeconds: d.sessionMaxAgeSeconds,
        storageTier: d.storageTier ?? "unavailable",
        authRequired: d.authRequired,
        lastVerifiedAt: d.lastVerifiedAt,
        lastErrorCode: d.lastErrorCode,
        // Pinned like every other URL that reaches a renderer.
        links: d.links
          ? {
              account: safeExternalUrl(d.links.account),
              subscribe: safeExternalUrl(d.links.subscribe),
            }
          : undefined,
        authRevision: d.authRevision,
      };
    }
    return null;
  }

  /** Runs a command to completion with a bound. */
  private runToCompletion(
    bin: string,
    args: string[],
    timeoutMs: number
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = this.spawnProcess(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: this.commandEnv(),
      }) as AccountChild;
      this.track(child);

      let stdout = "";
      let stderr = "";
      let settled = false;

      const done = (code: number | null, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      };

      const timer = setTimeout(() => {
        this.terminate(child);
        done(null, true);
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: string) => {
        if (stdout.length < MAX_STREAM_BYTES) stdout += c;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c: string) => {
        if (stderr.length < MAX_STREAM_BYTES) stderr += c;
      });
      child.on("error", (err) => {
        stderr += err.message;
        done(null, false);
      });
      child.on("close", (code) => done(code, false));
    });
  }
}

/** The process-wide instance. One CLI, one login at a time. */
export const assistantAccountService = new AssistantAccountService();

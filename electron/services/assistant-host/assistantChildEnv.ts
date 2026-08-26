/**
 * The environment every Daintree-spawned assistant child starts from.
 *
 * Extracted when Daintree's own assistant subprocesses were found to be inheriting
 * `process.env` whole. Daintree now spawns exactly one thing from the vendored binary —
 * the engine — but the list stays a named export rather than an inline literal: these
 * are the variables that decide what the assistant may do and where it sends what it is
 * given, and that is worth being able to point at.
 */

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
 *
 * The list is not assembled from what Daintree happens to set. It is the engine's OWN
 * definition of the surface, and the engine has two doors. The first it states in one
 * place: `trustedGet` / `trustedOrOwnGet` in the vendored `internal/config/config.go`,
 * whose whole contract is "real env only — the injecting host may set this, a bound
 * project's `.env` may not". Every name the engine reads through that door belongs here,
 * because for each of them the engine has already decided the value is too dangerous to
 * accept from a repository it opened, and an unexported-then-inherited shell variable is
 * a strictly less trustworthy source than the repository.
 *
 * The second door is `os.Getenv` called outside config resolution altogether — the
 * control-socket root, the daemon switches, the boot trace. Those never pass the trust
 * tiering at all, because the engine documents them as test-only or operator-only and
 * both of those set their own environment deliberately; nothing about that stops one
 * reaching a real session from a shell that exported it months ago.
 *
 * Reading half a door and leaving the rest is the shape of every gap this list has
 * closed: the endpoint was stripped while the switch that authorizes an unsafe endpoint
 * was not, the tier was stripped while the state directory that decides whose session it
 * is was not, and the state directory was stripped while the socket the session has to
 * find its supervisor over was not.
 */
export const ENGINE_CONTROLLED_ENV = [
  "DAINTREE_MCP_URL",
  "DAINTREE_MCP_TOKEN",
  "DAINTREE_ASSISTANT_TIER",
  "DAINTREE_ASSISTANT_AUTO_APPROVE",
  "DAINTREE_ASSISTANT_DEBUG_LOG",
  "DAINTREE_ASSISTANT_LOG_DIR",
  "DAINTREE_PROJECT_ID",
  "DAINTREE_WINDOW_ID",
  // A DEPRECATED caller bearer (`APIKey` in internal/config/config.go), not the upstream
  // credential that funds a turn — the backend holds its own, and the doctor row spells
  // the distinction out: "it identifies the CALLER; the backend still funds the turn"
  // (internal/cli/run.go). What it does now is OVERRIDE sign-in, and it does so at app
  // construction: a set key makes `NewAccountManager` return nil
  // (internal/app/backendclient.go), so the account token source is never built and
  // every turn goes out under the key rather than the account `/login` established. The
  // engine says as much itself — `doctor` reports the key "is overriding account
  // sign-in", `auth status` warns it "will stop overriding" (internal/cli/auth.go).
  // Daintree never sets this, so without the strip its only route into the child is
  // inheritance — and the dangerous case is not the key that gets rejected, it is the one
  // the backend accepts: `ValidateKeyShape` (internal/backend/endpoint.go) checks shape,
  // not credentials, so a stale key passes startup either way and only the request finds
  // out. An accepted one displaces the signed-in account for the whole session with
  // nothing raised unprompted to say so — the deprecation notice is on `doctor` and
  // `auth status`, which nobody runs mid-turn. Stripped and never re-set, which is what
  // keeps the CLI's own sign-in authoritative.
  "DAINTREE_API_KEY",
  // The endpoint.
  //
  // Daintree no longer SETS this — the engine owns its own endpoint now, chosen with
  // `/backend` and remembered across restarts — but it is still stripped, and the strip
  // is the whole guard. The threat is an INHERITED value: one exported in a shell months
  // ago, set by a parent process, or left in a CI environment, silently routing every
  // prompt, file path and command the assistant carries to somewhere nobody chose. The
  // engine treats the variable as a pin that outranks the stored choice and cannot be
  // switched away from in-session (`ErrBackendPinned`), so letting one through would
  // both repoint the session and disable the command that could move it back.
  "DAINTREE_BACKEND_URL",
  // The switch that authorizes the endpoint above to be plaintext `http://` to a remote
  // host. Stripping the endpoint and keeping this is half a guard: the engine also
  // remembers a STORED endpoint across restarts, so an inherited `=1` needs no inherited
  // URL to matter — it silently lifts the TLS floor on whatever the stored preference
  // is, and every turn, prompt and bearer crosses that wire in the clear. The engine
  // reads it as trusted-only for exactly this reason ("a bound project's .env must not
  // be able to authorize plaintext for an endpoint it does not control"), and a shell
  // variable exported months ago is no more entitled to that than a bound project is.
  "DAINTREE_ALLOW_INSECURE_BACKEND",
  // Where the engine keeps its session state — including the auth-revision marker the
  // embedded engine polls to notice that the standalone CLI signed in or out. Daintree
  // deliberately does NOT set this: sharing the default location is what makes one
  // sign-in serve both. An inherited value silently splits them, so the panel would keep
  // running against credentials the CLI had already revoked, with nothing to show for it.
  "DAINTREE_ASSISTANT_STATE_DIR",
  // Turns off every network path the engine has. Inherited, it presents as an assistant
  // that fails every turn for no reason Daintree can name, on a machine that is online.
  "DAINTREE_ASSISTANT_OFFLINE",
  // Routing policy: which upstream endpoints a turn may reach, in what order, and under
  // what privacy constraint. `ONLY` and `IGNORE` are endpoint lists, so they are the
  // same class of decision as the backend URL itself — an inherited pair repoints where
  // the conversation goes without touching the variable that names the backend.
  "DAINTREE_ROUTING_PRIVACY",
  "DAINTREE_ROUTING_SORT",
  "DAINTREE_ROUTING_ONLY",
  "DAINTREE_ROUTING_IGNORE",
  // Where the engine looks for control sockets (`internal/ipc/socket.go`). Daintree spawns
  // `host --stdio`, and the embedded host takes the project owner lease exactly as an
  // interactive session does: find the supervisor daemon over its socket and ask it to
  // yield, THEN flock (`acquireOwnership` in internal/cli/host.go, `AcquireOwnership` in
  // internal/supervisor/attach.go). The lease itself is `owner.lock` inside the state dir,
  // so a wrong socket root cannot split it — it does something more boring and more
  // total: the host cannot find the daemon holding that lock, so nothing tells it to stand
  // down and the flock is waited out to the 60s deadline and fails `ErrProjectBusy`. The
  // panel does not start, and the reason is a variable nobody remembers exporting.
  "DAINTREE_ASSISTANT_SOCKET_DIR",
  // Daemon auto-spawn, off. The engine calls this an operator kill switch as well as a
  // test knob, and stripping it does mean the embedded engine will not honour it — that is
  // the trade: the flock is correctness and the daemon is durability, so an ambient `=1`
  // corrupts nothing, it just removes the supervisor that carries watchers, timers and
  // async work after the panel detaches. An operator who wants that has the standalone
  // CLI, where the variable is theirs to set deliberately.
  "DAINTREE_ASSISTANT_NO_DAEMON",
  // The daemon's TEST-ONLY cadences (`internal/cli/daemon.go`, `internal/supervisor/
  // runtime.go`): `FAST` compresses the monitor tick, the MCP-blocked threshold and the
  // reconnect budget to sub-second values, so the engine's e2e suite can watch an outage
  // happen without minute-scale sleeps. Inherited into a real session, a momentary MCP
  // hiccup is declared blocked half a second in and the reconnect budget burns out in
  // seconds. `IDLE_EXIT_MS` shortens the window after which the supervisor exits once
  // nothing is left to supervise — background work outliving the panel is what it is for.
  "DAINTREE_ASSISTANT_DAEMON_FAST",
  "DAINTREE_ASSISTANT_DAEMON_IDLE_EXIT_MS",
  // Names a file the engine appends boot timings to, opened before any config exists
  // (`internal/debuglog/boottrace.go`). Not a safety control like the rest of this list —
  // it is here because it is the one variable that makes the engine write to a path taken
  // from the environment, on every launch, for a benchmark nobody is running.
  "DAINTREE_ASSISTANT_BOOT_TRACE",
  // A capability flag, read through `trustedOrOwnGet` and surfaced as one
  // (`internal/app/capabilityref.go`): with it off the engine registers none of the
  // execution-graph tools, so the runbooks written against them announce a plan and then
  // find nothing to build it with. It is a supported compatibility switch for an older
  // backend, which is why stripping it is a decision and not a bug fix — the embedded
  // engine takes its capability set from Daintree's default, not from the shell Electron
  // happened to be launched from, and the engine has already ruled that a bound repository
  // may not decide this either.
  "DAINTREE_WORKFLOW_INTELLIGENCE",
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
 * An inherited environment with the assistant-control variables removed.
 *
 * The list is applied by everything Daintree spawns from the vendored binary. It once
 * had to be, because a second consumer (the account commands) was inheriting
 * `process.env` whole, and that asymmetry was not academic: the engine was carefully
 * denied an ambient `DAINTREE_API_KEY` while the commands reporting who you were signed
 * in as were handed it.
 */
export function assistantChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENGINE_CONTROLLED_ENV_UPPER.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  return env;
}

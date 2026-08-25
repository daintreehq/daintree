import { spawn } from "node:child_process";

import { ASSISTANT_HOST_PROTOCOL_VERSION } from "../../../shared/types/ipc/assistantHost.js";
import { assistantPlatformSupport } from "../../../shared/config/assistantPlatform.js";
import { assistantBackendEnvironment } from "../../../shared/config/assistantBackend.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { getHelpAssistantSettings } from "../../ipc/handlers/helpAssistant.js";
import { assistantChildEnv } from "./assistantChildEnv.js";
import { resolveAssistantBinary } from "./resolveAssistantBinary.js";
import { resolveBackendUrl } from "./resolveBackendUrl.js";
import { probeAssistantBackend } from "./probeBackend.js";
import type { AssistantDiagnostics } from "../../../shared/types/ipc/assistantHostIpc.js";

/**
 * What a broken assistant looks like from the outside, in one answer.
 *
 * The questions this is built to settle are the ones that otherwise take a support
 * thread: which endpoint is it ACTUALLY talking to (not which one is selected — the two
 * came apart once already), is that endpoint even a backend, which engine build is
 * this, and do the two sides agree on the protocol.
 *
 * ## What this does and does not promise about secrets
 *
 * Daintree's OWN secrets cannot appear: no token, bearer or MCP value is read here, the
 * probe sends no credentials, and the resolved origin is stripped of userinfo, query and
 * fragment before it is reported. What this is not is a payload that structurally cannot
 * carry a secret — several fields are free text (a binary path the user chose, a version
 * string an engine printed, a snippet of whatever answered the probe), and free text
 * belongs to whoever produced it. It is safe to show the user their own configuration;
 * it is not a guarantee about a body some other server returned.
 *
 * The engine's own `doctor` is deliberately not shelled out to, despite producing very
 * nearly this report: it takes the project's owner lease, which a live session is
 * already holding, so asking would either block or report the user's own working
 * assistant as a fault.
 */

/** One read at a time. See `collectAssistantDiagnostics`. */
let inFlight: Promise<AssistantDiagnostics> | null = null;

/** Bounded: a diagnostics read is a button press, not a background job. */
const VERSION_TIMEOUT_MS = 5_000;

/**
 * Collects the readout, coalescing concurrent callers.
 *
 * Single-flight because each read spawns a process and makes a network request, and the
 * IPC behind it takes no arguments and needs no session — so a renderer in a loop, or
 * simply an impatient double-click, would otherwise multiply both. Disabling the button
 * is a courtesy to the user, not a bound on the main process.
 */
export function collectAssistantDiagnostics(): Promise<AssistantDiagnostics> {
  inFlight ??= collect().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function collect(): Promise<AssistantDiagnostics> {
  const platform = assistantPlatformSupport(process.platform);
  const settings = getHelpAssistantSettings();
  // The RESOLVED origin, through the same call the spawn uses — so this reports where
  // turns actually go, including when an environment variable has overridden or been
  // refused. Reporting the selected environment alone is what made the original
  // divergence invisible.
  const backendUrl = resolveBackendUrl(
    process.env.DAINTREE_BACKEND_URL,
    settings.backendEnvironment
  );

  // Concurrent: they are independent, and each has its own five-second ceiling. Run in
  // sequence the worst case is ten seconds of a button looking stuck.
  const [engine, backend] = await Promise.all([
    describeEngine(),
    probeAssistantBackend(displayUrl(backendUrl)),
  ]);

  return {
    platform: {
      os: process.platform,
      arch: process.arch,
      supported: platform.supported,
      ...(platform.supported ? {} : { unsupportedReason: platform.reason }),
    },
    environment: {
      selected: settings.backendEnvironment,
      resolvedUrl: displayUrl(backendUrl),
      // Three-way, not a boolean. "The variable moved the endpoint", "the variable is
      // set and was REFUSED", and "no variable" send a reader to three different places,
      // and collapsing the middle one into "overridden" would explain a resolved origin
      // by pointing at a value that had nothing to do with it.
      envOverride: describeOverride(backendUrl, settings.backendEnvironment),
    },
    engine,
    backend,
    // Daintree's host<->engine protocol constant. Deliberately NOT called agreement:
    // this is what THIS build speaks, and the engine's answer is only known once a
    // session reaches `host:ready`. The backend's own protocol range is a third,
    // unrelated number.
    hostProtocolVersion: ASSISTANT_HOST_PROTOCOL_VERSION,
  };
}

/**
 * An origin fit to be read, copied, and pasted into a bug report.
 *
 * `resolveBackendUrl` hands back the parser's canonical `href`, and a loopback override
 * may legitimately carry userinfo — `http://user:pass@127.0.0.1:8473` passes the
 * loopback check, because the parser reports its hostname as `127.0.0.1`. That is fine
 * for the engine, which needs the credentials, and not fine here: this readout exists to
 * be copied into an issue, and the whole point of a payload that cannot carry a secret
 * is that it cannot carry one by accident either.
 *
 * The query and fragment go for the same reason — a developer pointing at a local
 * backend with `?token=` is exactly the shape this is guarding.
 */
function displayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Unparseable here would mean the resolver returned something it cannot have
    // returned, but a readout must not be the thing that throws.
    return raw;
  }
  const carriesCredentials = Boolean(url.username || url.password);
  if (!carriesCredentials && !url.search && !url.hash) {
    // Nothing to hide — hand back the string VERBATIM. Round-tripping through the URL
    // parser would normalise it (a bare origin gains a trailing slash), and a readout
    // whose whole job is "this is the value we spawn with" should not quietly print a
    // different one.
    return raw;
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  // Said, not silently dropped: a reader chasing an auth failure needs to know the
  // endpoint has credentials on it.
  return carriesCredentials ? `${url.toString()} (credentials hidden)` : url.toString();
}

/**
 * Whether `DAINTREE_BACKEND_URL` is set, and whether it actually did anything.
 *
 * The resolver silently refuses an off-box value and falls back to the chosen
 * environment. That is the right behaviour and an invisible one — so a reader looking at
 * a resolved origin that is not what they exported needs to be told the variable is
 * there AND that it was declined, not left to conclude the setting is broken.
 */
function describeOverride(
  resolved: string,
  selectedEnvironment: string
): AssistantDiagnostics["environment"]["envOverride"] {
  const raw = process.env.DAINTREE_BACKEND_URL?.trim();
  if (!raw) return "none";
  return resolved ===
    assistantBackendEnvironment(
      selectedEnvironment as Parameters<typeof assistantBackendEnvironment>[0]
    ).url
    ? "refused"
    : "applied";
}

/** The engine binary Daintree would actually spawn, and what it says it is. */
async function describeEngine(): Promise<AssistantDiagnostics["engine"]> {
  let binaryPath: string;
  try {
    binaryPath = await resolveAssistantBinary();
  } catch (error) {
    // Not found is a diagnosis, not a failure of the diagnostic.
    return { found: false, detail: formatErrorMessage(error, "The engine could not be located.") };
  }

  const version = await readVersion(binaryPath);
  return { found: true, binaryPath, ...(version ? { version } : {}) };
}

/** Runs `--version`, bounded. Returns null rather than throwing — this is a readout. */
function readVersion(binaryPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
      // The same stripped environment every other assistant child gets. A `--version`
      // read is harmless, but an inherited control variable reaching one child and not
      // another is how the two drift out of agreement about what they are.
      env: assistantChildEnv(),
    });
    let out = "";
    const done = (value: string | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      done(null);
    }, VERSION_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      // Bounded: this is a version string, and an engine that streams instead is not
      // one this build should be quoting back into the UI.
      if (out.length < 2_000) out += chunk;
    });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 && out.trim() ? out.trim().split("\n")[0]! : null));
  });
}

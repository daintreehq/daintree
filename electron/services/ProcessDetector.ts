import type { BuiltInAgentId } from "../../shared/config/agentIds.js";
import type { ProcessTreeCache } from "./ProcessTreeCache.js";
import { logDebug, logWarn } from "../utils/logger.js";
import { AGENT_REGISTRY } from "../../shared/config/agentRegistry.js";

interface ChildProcess {
  pid: number;
  name: string;
  command?: string;
}

interface DetectedProcessCandidate {
  agentType?: BuiltInAgentId;
  processIconId?: string;
  processName: string;
  processCommand?: string;
  priority: number;
  order: number;
}

// npm-package-tail aliases cover wrapper invocations where the binary name
// isn't in argv but the package tail is (`npx @anthropic-ai/claude-code`,
// `node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js`).
// extractCommandNameCandidates strips the scope prefix to the tail, so
// mapping the tail → agent id here is enough to close that hole.
function packageTail(pkg: string | undefined): string | undefined {
  if (!pkg) return undefined;
  const tail = pkg.split("/").pop();
  return tail && tail.length > 0 ? tail : undefined;
}

/** Reads `packages.npm` first; falls back to deprecated top-level `npmGlobalPackage`. */
function effectiveNpmPackage(config: {
  packages?: { npm?: string };
  npmGlobalPackage?: string;
}): string | undefined {
  return config.packages?.npm ?? config.npmGlobalPackage;
}

const AGENT_CLI_NAMES: Record<string, BuiltInAgentId> = Object.fromEntries(
  Object.entries(AGENT_REGISTRY).flatMap(([id, config]) => {
    const entries: [string, BuiltInAgentId][] = [[config.command, id as BuiltInAgentId]];
    if (config.command !== id) {
      entries.push([id, id as BuiltInAgentId]);
    }
    const tail = packageTail(effectiveNpmPackage(config));
    if (tail && tail !== config.command && tail !== id) {
      entries.push([tail, id as BuiltInAgentId]);
    }
    return entries;
  })
);

const PROCESS_ICON_MAP: Record<string, string> = {
  // AI agents (derived from registry)
  ...Object.fromEntries(
    Object.entries(AGENT_REGISTRY).flatMap(([id, config]) => {
      const entries: [string, string][] = [[id, config.iconId]];
      if (config.command !== id) {
        entries.push([config.command, config.iconId]);
      }
      const tail = packageTail(effectiveNpmPackage(config));
      if (tail && tail !== config.command && tail !== id) {
        entries.push([tail, config.iconId]);
      }
      return entries;
    })
  ),
  // Package managers
  npm: "npm",
  npx: "npm",
  yarn: "yarn",
  pnpm: "pnpm",
  bun: "bun",
  composer: "composer",
  // Language runtimes
  python: "python",
  python3: "python",
  node: "node",
  deno: "deno",
  ruby: "ruby",
  rails: "ruby",
  bundle: "ruby",
  go: "go",
  cargo: "rust",
  rustc: "rust",
  php: "php",
  kotlin: "kotlin",
  kotlinc: "kotlin",
  swift: "swift",
  swiftc: "swift",
  elixir: "elixir",
  mix: "elixir",
  iex: "elixir",
  // Build tools
  gradle: "gradle",
  gradlew: "gradle",
  webpack: "webpack",
  vite: "vite",
  // Infrastructure
  docker: "docker",
  terraform: "terraform",
  tofu: "terraform",
};

const PACKAGE_MANAGER_ICON_IDS = new Set(["npm", "yarn", "pnpm", "bun", "composer"]);

const IDENTITY_DEBUG_ENABLED =
  process.env.NODE_ENV === "development" || Boolean(process.env.DAINTREE_DEBUG);

function logIdentityDebug(message: string): void {
  if (IDENTITY_DEBUG_ENABLED) {
    console.log(message);
  }
}

/**
 * Extract non-flag command name candidates from a full `command` line in
 * argv order. Used when `comm` basename doesn't match a known CLI — most
 * commonly for Node-hosted CLIs where `comm = "node"` and argv[1] is the
 * agent script path (`node /path/to/claude --resume`).
 *
 * Shell quotes and path separators are stripped so
 * `'/Users/me/.local/bin/claude' --flag` resolves to `claude`.
 * Extensions like .js / .py / .rb are stripped so "claude.mjs" → "claude".
 * Returns argv[0], argv[1], argv[2] basenames.
 *
 * NOTE: if a process sets `process.title` after launch, macOS `ps` reports
 * the rewritten argv — the original invocation is NOT preserved in the
 * `command` column. Callers should not rely on this to recover identity
 * after a process has rewritten its title.
 */
export function extractCommandNameCandidates(command: string | undefined): string[] {
  if (!command) return [];
  const parts = splitShellLikeCommand(command);
  const candidates: string[] = [];
  for (let i = 0; i < parts.length && candidates.length < 3; i++) {
    const arg = parts[i];
    if (!arg || arg.startsWith("-")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    const basename = arg.split(/[\\/]/).pop();
    if (!basename) continue;
    const withoutExt = basename
      .replace(/\.exe$/i, "")
      .replace(/\.(m?js|cjs|ts|py|rb|php|pl)$/i, "");
    if (withoutExt) candidates.push(withoutExt);
  }
  return candidates;
}

function splitShellLikeCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | `"` | null = null;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === "'" || char === `"`) && quote === null) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (quote === null && /\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (current) {
    parts.push(current);
  }

  return parts;
}

/** @deprecated Use extractCommandNameCandidates — retained for test import. */
export function extractScriptBasenameFromCommand(command: string | undefined): string | null {
  const all = extractCommandNameCandidates(command);
  // Previous behaviour: skip argv[0], return argv[1]. Preserved so older
  // tests that assume "only the script, not the runtime" still pass.
  return all[1] ?? null;
}

// Diagnostic logs must never carry full argv — users can legitimately pass
// secrets inline (e.g. `claude --api-key=…`, `gh auth --token …`). Keep only
// argv[0]'s basename so log noise still identifies the runtime without
// leaking credentials into console or into window.__daintreeIdentityEvents().
export function redactArgv(command: string | undefined): string {
  if (!command) return "";
  const first = splitShellLikeCommand(command)[0];
  if (!first) return "";
  const basename = first.split(/[\\/]/).pop() ?? first;
  return JSON.stringify(basename);
}

export interface CommandIdentity {
  agentType?: BuiltInAgentId;
  processIconId?: string;
  processName: string;
}

/**
 * Best-effort identity resolution from a shell command line.
 *
 * Used by the runtime shell-command fallback in TerminalProcess when the PTY
 * process tree is blind or a CLI rewrites its own process title. This shares
 * the same agent/process icon registry as the process-tree detector so chrome
 * stays consistent regardless of which signal produced the identity.
 */
export function detectCommandIdentity(command: string | undefined): CommandIdentity | null {
  const candidates = extractCommandNameCandidates(command);
  let iconMatch: { name: string; icon: string } | null = null;

  for (const candidate of candidates) {
    const lowerCandidate = candidate.toLowerCase();
    const candidateAgent = AGENT_CLI_NAMES[lowerCandidate];
    if (candidateAgent) {
      return {
        agentType: candidateAgent,
        processIconId: PROCESS_ICON_MAP[lowerCandidate],
        processName: candidate,
      };
    }

    if (!iconMatch) {
      const candidateIcon = PROCESS_ICON_MAP[lowerCandidate];
      if (candidateIcon) {
        iconMatch = { name: candidate, icon: candidateIcon };
      }
    }
  }

  if (!iconMatch) {
    return null;
  }

  return {
    processIconId: iconMatch.icon,
    processName: iconMatch.name,
  };
}

/**
 * Explicit detection state. Ambiguity is first-class — `unknown` means we have
 * no evidence (cache error, blind `ps`, invalid PID) and should not mutate
 * committed state; `ambiguous` means we have conflicting positive evidence
 * from two independent sources and are holding until one stabilises. Only
 * `agent` and `no_agent` drive actual state changes in consumers.
 */
export type DetectionState = "unknown" | "no_agent" | "agent" | "ambiguous";

/** Which signal produced the committed agent identity, for diagnostics. */
export type DetectionEvidenceSource = "process_tree" | "shell_command" | "both";

export interface DetectionResult {
  detectionState: DetectionState;
  /** @deprecated Use `detectionState === "agent"`. Retained for legacy consumers. */
  detected: boolean;
  agentType?: BuiltInAgentId;
  processIconId?: string;
  processName?: string;
  isBusy?: boolean;
  currentCommand?: string;
  evidenceSource?: DetectionEvidenceSource;
}

export type DetectionCallback = (result: DetectionResult, spawnedAt: number) => void;

export function makeAgentResult(params: {
  agentType?: BuiltInAgentId;
  processIconId?: string;
  processName?: string;
  isBusy?: boolean;
  currentCommand?: string;
  evidenceSource?: DetectionEvidenceSource;
}): DetectionResult {
  return {
    detectionState: "agent",
    detected: true,
    agentType: params.agentType,
    processIconId: params.processIconId,
    processName: params.processName,
    isBusy: params.isBusy,
    currentCommand: params.currentCommand,
    evidenceSource: params.evidenceSource,
  };
}

export function makeNoAgentResult(params: {
  isBusy?: boolean;
  currentCommand?: string;
  evidenceSource?: DetectionEvidenceSource;
}): DetectionResult {
  return {
    detectionState: "no_agent",
    detected: false,
    isBusy: params.isBusy,
    currentCommand: params.currentCommand,
    evidenceSource: params.evidenceSource,
  };
}

export function makeUnknownResult(params?: {
  isBusy?: boolean;
  currentCommand?: string;
}): DetectionResult {
  return {
    detectionState: "unknown",
    detected: false,
    isBusy: params?.isBusy,
    currentCommand: params?.currentCommand,
  };
}

export function makeAmbiguousResult(params: {
  isBusy?: boolean;
  currentCommand?: string;
  evidenceSource?: DetectionEvidenceSource;
}): DetectionResult {
  return {
    detectionState: "ambiguous",
    detected: false,
    isBusy: params.isBusy,
    currentCommand: params.currentCommand,
    evidenceSource: params.evidenceSource,
  };
}

export class ProcessDetector {
  // Require N consecutive polls agreeing on a new agent/icon state before
  // committing it. At the 1500 ms base poll interval that is ~3 s of confirmation,
  // which is enough to filter out short-lived processes (e.g. `claude --version`)
  // that would otherwise cause the detector to thrash between on/off.
  private static readonly HYSTERESIS_THRESHOLD = 2;

  // Asymmetric TTLs for shell-command evidence. Sticky window suppresses the
  // off-streak — a fresh shell-command commit anchors the detector through
  // blind `ps` cycles and short-lived subprocess thrash without waiting for
  // the next process-tree poll to re-confirm. Absolute upper bound prevents
  // a synthetic shell identity from holding `agent` forever if the process
  // never actually started. #5809
  private static readonly SHELL_COMMAND_STICKY_MS = 12_000;
  private static readonly SHELL_COMMAND_EXPIRY_MS = 30_000;

  private terminalId: string;
  private spawnedAt: number;
  private ptyPid: number;
  private callback: DetectionCallback;
  private lastDetected: BuiltInAgentId | null = null;
  private lastProcessIconId: string | null = null;
  private lastBusyState: boolean | null = null;
  private lastCurrentCommand: string | undefined;
  private lastEvidenceSource: DetectionEvidenceSource | null = null;
  private cache: ProcessTreeCache;
  private unsubscribe: (() => void) | null = null;
  private isStarted: boolean = false;
  private onStreak: number = 0;
  private offStreak: number = 0;
  private pendingDetected: { agentType?: BuiltInAgentId; processIconId?: string } | null = null;
  private lastUnknownSignature: string | null = null;
  private lastPassSignature: string | null = null;
  private lastShellEvidenceRetentionSignature: string | null = null;

  // Shell-command evidence injected by TerminalProcess when a command is
  // submitted through the PTY. Merges with process-tree evidence inside
  // detectAgent() so the two signals arrive at a single committed result.
  private shellCommandIdentity: CommandIdentity | null = null;
  private shellCommandText: string | undefined;
  private shellCommandStickyUntil: number = 0;
  private shellCommandExpiresAt: number = 0;

  constructor(
    terminalId: string,
    spawnedAt: number,
    ptyPid: number,
    callback: DetectionCallback,
    cache: ProcessTreeCache
  ) {
    this.terminalId = terminalId;
    this.spawnedAt = spawnedAt;
    this.ptyPid = ptyPid;
    this.callback = callback;
    this.cache = cache;
  }

  /**
   * Inject shell-command evidence from a PTY input capture. Called by
   * TerminalProcess after parsing a submitted command line so the detector
   * can merge the shell identity with process-tree observations in one
   * place. Triggers a synchronous `detect()` so fast commits (~1.2 s) are
   * preserved without waiting for the next cache poll (~2.5 s). The sticky
   * TTL (12 s) then suppresses off-streak counting so short-lived subprocess
   * thrash doesn't demote a confident commit. #5809
   */
  injectShellCommandEvidence(
    identity: CommandIdentity,
    commandText?: string,
    observedAt: number = Date.now()
  ): void {
    this.shellCommandIdentity = identity;
    this.shellCommandText = commandText;
    this.shellCommandStickyUntil = observedAt + ProcessDetector.SHELL_COMMAND_STICKY_MS;
    this.shellCommandExpiresAt = observedAt + ProcessDetector.SHELL_COMMAND_EXPIRY_MS;

    logIdentityDebug(
      `[IdentityDebug] shell-evidence term=${this.terminalId.slice(-8)} ` +
        `agent=${identity.agentType ?? "<none>"} icon=${identity.processIconId ?? "<none>"} ` +
        `name=${JSON.stringify(identity.processName)}`
    );
    this.lastPassSignature = null;

    // Only run the sync detect pass once attached — before start() the cache
    // callback is not wired and invoking detect() early emits from a detector
    // that hasn't announced itself yet.
    if (this.isStarted) {
      this.detect();
    }
  }

  /**
   * Clear any injected shell-command evidence. Called by TerminalProcess on
   * prompt-return (the command finished) or on terminal teardown.
   *
   * Prompt-return is an explicit lifecycle signal: the shell prompt came back,
   * so the agent command finished. That is allowed to demote an agent. Timer
   * expiry and process-tree absence are not allowed to demote agents because
   * idle CLIs can rewrite argv/comm or briefly disappear from process scans.
   */
  clearShellCommandEvidence(reason = "manual"): void {
    const promptReturned = reason === "prompt-return";
    const shellWasSoleSupport =
      this.lastEvidenceSource === "shell_command" &&
      (this.lastDetected !== null || this.lastProcessIconId !== null);
    const shouldDemoteCommittedAgent = promptReturned && this.lastDetected !== null;
    // Prompt-return is an explicit lifecycle signal: the typed command has
    // finished, so any badge that command produced (npm/node/docker/etc.) is
    // stale and must clear. The earlier `shellWasSoleSupport` gate over-
    // restricted this — the process-tree path can independently corroborate
    // the icon (Case C in mergeWithShellEvidence stamps `evidenceSource:
    // "process_tree"`), and a race where shell-evidence clears before the
    // tree-only-empty off-streak commits would otherwise strand the badge
    // for the full ProcessTreeCache poll cycle (up to 15s under adaptive
    // backoff) — or indefinitely if the cache enters an error state. For
    // manual/expired clears we still require sole support so a still-
    // running tree-corroborated process keeps its icon. #5813
    const shouldDemoteCommittedProcessIcon =
      this.lastDetected === null &&
      this.lastProcessIconId !== null &&
      (promptReturned || shellWasSoleSupport);

    if (this.shellCommandIdentity !== null) {
      logIdentityDebug(
        `[IdentityDebug] shell-evidence-clear term=${this.terminalId.slice(-8)} ` +
          `reason=${reason} agent=${this.shellCommandIdentity.agentType ?? "<none>"} ` +
          `icon=${this.shellCommandIdentity.processIconId ?? "<none>"} ` +
          `soleSupport=${shellWasSoleSupport} promptReturned=${promptReturned}`
      );
    }

    this.shellCommandIdentity = null;
    this.shellCommandText = undefined;
    this.shellCommandStickyUntil = 0;
    this.shellCommandExpiresAt = 0;

    if ((shouldDemoteCommittedAgent || shouldDemoteCommittedProcessIcon) && this.isStarted) {
      this.lastDetected = null;
      this.lastProcessIconId = null;
      this.lastEvidenceSource = null;
      this.lastBusyState = false;
      this.lastCurrentCommand = undefined;
      this.onStreak = 0;
      this.offStreak = 0;
      this.pendingDetected = null;
      try {
        this.callback(
          makeNoAgentResult({
            isBusy: false,
            currentCommand: undefined,
            evidenceSource: promptReturned ? "shell_command" : undefined,
          }),
          this.spawnedAt
        );
      } catch (err) {
        console.error(
          `ProcessDetector clear-shell demote error for terminal ${this.terminalId}:`,
          err
        );
      }
    }
  }

  start(): void {
    if (this.isStarted) {
      logIdentityDebug(
        `[IdentityDebug] detector START-SKIPPED term=${this.terminalId.slice(-8)} pid=${this.ptyPid} reason=already-started`
      );
      logWarn(`ProcessDetector for terminal ${this.terminalId} already started`);
      return;
    }

    logIdentityDebug(
      `[IdentityDebug] detector START term=${this.terminalId.slice(-8)} pid=${this.ptyPid}`
    );

    this.isStarted = true;
    this.detect();

    let firstRefresh = true;
    this.unsubscribe = this.cache.onRefresh(() => {
      if (firstRefresh) {
        firstRefresh = false;
        logIdentityDebug(
          `[IdentityDebug] detector FIRST-TICK term=${this.terminalId.slice(-8)} pid=${this.ptyPid} children=${this.cache.getChildren(this.ptyPid).length}`
        );
      }
      this.detect();
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      // Clear any injected shell-command evidence first so the teardown flush
      // emits a clean no_agent result and no stale identity lingers across a
      // same-session restart of the detector.
      this.clearShellCommandEvidence();

      // Flush a pending OFF streak on teardown so a detected agent whose process
      // exited inside the hysteresis window does not leave ghost state in the UI.
      if (this.offStreak > 0 && (this.lastDetected !== null || this.lastProcessIconId !== null)) {
        const spawnedAt = this.spawnedAt;
        this.lastDetected = null;
        this.lastProcessIconId = null;
        this.lastBusyState = false;
        this.lastCurrentCommand = undefined;
        this.lastEvidenceSource = null;
        this.offStreak = 0;
        this.onStreak = 0;
        this.pendingDetected = null;
        try {
          this.callback(makeNoAgentResult({ isBusy: false, currentCommand: undefined }), spawnedAt);
        } catch (err) {
          console.error(`ProcessDetector stop flush error for terminal ${this.terminalId}:`, err);
        }
      } else {
        this.onStreak = 0;
        this.offStreak = 0;
        this.pendingDetected = null;
      }

      this.unsubscribe();
      this.unsubscribe = null;
      logDebug(`Stopped ProcessDetector for terminal ${this.terminalId}`);
    }
    this.isStarted = false;
  }

  private detect(): void {
    try {
      // Expire stale non-agent shell-command evidence before each detect pass
      // so short-lived process badges (npm/docker/etc.) do not pin chrome.
      // Agent evidence is deliberately NOT expired here. Agents demote only on
      // explicit lifecycle signals (prompt-return/PTy exit/kill), not on timer
      // expiry or process-tree absence. Real CLIs can rewrite argv/comm or look
      // idle in `ps` while still owning the terminal.
      if (
        this.shellCommandIdentity !== null &&
        this.shellCommandExpiresAt > 0 &&
        Date.now() > this.shellCommandExpiresAt
      ) {
        const childCount = this.getPtyChildCount();
        if (this.shellCommandIdentity.agentType) {
          const signature = `${this.shellCommandIdentity.agentType}|${childCount}`;
          if (signature !== this.lastShellEvidenceRetentionSignature) {
            this.lastShellEvidenceRetentionSignature = signature;
            logIdentityDebug(
              `[IdentityDebug] shell-evidence-retain term=${this.terminalId.slice(-8)} ` +
                `reason=agent-requires-explicit-exit agent=${this.shellCommandIdentity.agentType} ` +
                `children=${childCount}`
            );
          }
        } else {
          this.lastShellEvidenceRetentionSignature = null;
          this.clearShellCommandEvidence("expired");
        }
      }

      const result = this.detectAgent();

      // Per-pass log is gated behind DAINTREE_IDENTITY_DEBUG_PASS=1 so the hot
      // path is silent by default. Enable when diagnosing "detector ran but
      // didn't match" cases. The START, commit, and shell-evidence logs below
      // cover the common transition signals without hammering stdout.
      if (process.env.DAINTREE_IDENTITY_DEBUG_PASS === "1") {
        try {
          const children = this.cache.getChildren(this.ptyPid);
          const procs = children.map((p) => `${p.comm}(${p.pid})`).join(",") || "<none>";
          const passSignature = `${result.detectionState}|${result.agentType ?? ""}|${result.evidenceSource ?? ""}|${procs}`;
          if (passSignature !== this.lastPassSignature) {
            this.lastPassSignature = passSignature;
            logIdentityDebug(
              `[IdentityDebug] pass term=${this.terminalId.slice(-8)} pid=${this.ptyPid} ` +
                `state=${result.detectionState} agent=${result.agentType ?? "<none>"} ` +
                `src=${result.evidenceSource ?? "<none>"} procs=[${procs}]`
            );
          }
        } catch {
          // Diagnostic path must never throw into the detect loop.
        }
      }

      // `unknown` and `ambiguous` are first-class HOLD states — no committed-
      // state transitions and no side-channel emissions. A blind `ps` or a
      // two-source conflict genuinely has no reliable busy/command data to
      // report, so emitting anything here would leak uncertainty into
      // consumers (headline generators, state machines) that would then act
      // on it. Hold committed state silently until the cache recovers or the
      // conflict resolves. Precedent: #4153 — uncertain events must be no-ops,
      // not partial updates. #5809
      if (result.detectionState === "unknown" || result.detectionState === "ambiguous") {
        this.onStreak = 0;
        this.offStreak = 0;
        this.pendingDetected = null;
        return;
      }

      const rawAgent = result.agentType ?? null;
      const rawIcon = result.processIconId ?? null;
      const rawDetected = result.detectionState === "agent";
      const committedAgent = this.lastDetected;
      const committedIcon = this.lastProcessIconId;

      const agentOrIconDiffers = rawAgent !== committedAgent || rawIcon !== committedIcon;

      // Sticky TTL: when fresh shell-command evidence vouches for the currently
      // committed identity, suppress the off-streak entirely. Short-lived
      // subprocess thrash or blind `ps` cycles within the TTL window must not
      // produce a demotion commit. #5809
      const shellStickyActive =
        this.shellCommandIdentity !== null && Date.now() < this.shellCommandStickyUntil;

      let gatedCommitted = false;
      let heldAgentDemotion = false;

      // Fast-commit path for shell-sourced evidence. The shell-command
      // fallback already debounces at its capture site (~1.2 s prompt-not-
      // visible window) before injection, so requiring a second hysteresis
      // confirmation here would double-count the debounce and add ~2.5 s of
      // UI latency. When the evidence source is `shell_command` or `both`,
      // the decision is already backed by a second signal and can commit on
      // the first tick. Process-tree-only signals still go through
      // hysteresis to filter out short-lived subprocess thrash. #5809
      const isShellSourcedEvidence =
        result.evidenceSource === "shell_command" || result.evidenceSource === "both";

      if (agentOrIconDiffers) {
        if (rawDetected) {
          // ON or swap direction: count consecutive polls agreeing on the same
          // candidate; a different candidate mid-streak resets the counter.
          const sameCandidate =
            this.pendingDetected !== null &&
            (this.pendingDetected.agentType ?? null) === rawAgent &&
            (this.pendingDetected.processIconId ?? null) === rawIcon;

          this.onStreak = sameCandidate ? this.onStreak + 1 : 1;
          this.pendingDetected = {
            agentType: result.agentType,
            processIconId: result.processIconId,
          };
          this.offStreak = 0;

          const commitNow =
            isShellSourcedEvidence || this.onStreak >= ProcessDetector.HYSTERESIS_THRESHOLD;

          if (commitNow) {
            this.lastDetected = rawAgent;
            this.lastProcessIconId = rawIcon;
            this.lastEvidenceSource = result.evidenceSource ?? "process_tree";
            this.onStreak = 0;
            this.pendingDetected = null;
            gatedCommitted = true;
          }
        } else if (shellStickyActive) {
          // OFF direction suppressed by fresh shell evidence — hold committed
          // state, flush streaks, and emit nothing. Busy/command side-channel
          // emissions are still suppressed below via inPendingTransition=false
          // plus the committed match (but lastBusy/command updates will flow
          // naturally on matching ticks).
          this.onStreak = 0;
          this.offStreak = 0;
          this.pendingDetected = null;
        } else if (committedAgent !== null) {
          // Agent sessions are sticky until an explicit lifecycle signal
          // arrives. Process-tree absence is too weak: idle CLIs can rewrite
          // argv/comm, temporarily hide children, or show prompt-like TUI
          // elements while still running. Prompt-return clears via
          // clearShellCommandEvidence("prompt-return").
          if (this.offStreak === 0) {
            logIdentityDebug(
              `[IdentityDebug] demote-hold term=${this.terminalId.slice(-8)} ` +
                `reason=agent-requires-explicit-exit agent=${committedAgent} ` +
                `rawIcon=${rawIcon ?? "<none>"}`
            );
          }
          this.onStreak = 0;
          this.offStreak = 0;
          this.pendingDetected = null;
          heldAgentDemotion = true;
        } else {
          // OFF direction: raw reports no detection but committed state has one.
          this.offStreak += 1;
          this.onStreak = 0;
          this.pendingDetected = null;

          if (this.offStreak >= ProcessDetector.HYSTERESIS_THRESHOLD) {
            this.lastDetected = null;
            this.lastProcessIconId = null;
            this.lastEvidenceSource = null;
            this.offStreak = 0;
            gatedCommitted = true;
          }
        }
      } else {
        // Raw matches committed state — no transition in flight.
        this.onStreak = 0;
        this.offStreak = 0;
        this.pendingDetected = null;

        // Upgrade evidence source when the process tree later corroborates a
        // shell-only commit. This keeps diagnostics accurate and prevents a
        // non-lifecycle/manual shell-evidence clear from treating the shell as
        // the only support for a still-observed process. Prompt-return remains
        // an explicit lifecycle demotion regardless of corroboration. #5809
        if (
          rawDetected &&
          result.evidenceSource &&
          result.evidenceSource !== this.lastEvidenceSource
        ) {
          this.lastEvidenceSource = result.evidenceSource;
        }
      }

      const inPendingTransition = this.onStreak > 0 || this.offStreak > 0;

      const busyChanged = result.isBusy !== undefined && result.isBusy !== this.lastBusyState;
      const commandChanged = result.currentCommand !== this.lastCurrentCommand;

      // Suppress busy/command emissions while a gated transition is pending —
      // otherwise a one-poll blip would leak through the side-channel and undo
      // the hysteresis gate. Once the gated streak commits (or the raw state
      // stabilises back onto committed), immediate emissions resume.
      const shouldEmitImmediate =
        (busyChanged || commandChanged) && !inPendingTransition && !heldAgentDemotion;

      if (gatedCommitted || shouldEmitImmediate) {
        if (result.isBusy !== undefined) {
          this.lastBusyState = result.isBusy;
        }
        this.lastCurrentCommand = result.currentCommand;
        // Always-on, one line per committed state change. Lets us see in
        // logs whether detection is firing at all, without spam: this block
        // only runs when we actually emit (gatedCommitted or a busy/command
        // side-channel change).
        if (gatedCommitted) {
          logIdentityDebug(
            `[IdentityDebug] commit term=${this.terminalId.slice(-8)} pid=${this.ptyPid} state=${result.detectionState} agent=${result.agentType ?? "null"} icon=${result.processIconId ?? "null"} src=${result.evidenceSource ?? "process_tree"}`
          );
        }
        this.callback(result, this.spawnedAt);
      }
    } catch (_error) {
      console.error(`ProcessDetector error for terminal ${this.terminalId}:`, _error);
    }
  }

  private detectAgent(): DetectionResult {
    if (!Number.isInteger(this.ptyPid) || this.ptyPid <= 0) {
      // Invalid PID — no evidence, not negative evidence. Hold committed
      // state rather than emitting a demotion.
      console.warn(`Invalid PTY PID for terminal ${this.terminalId}: ${this.ptyPid}`);
      return makeUnknownResult({ isBusy: false });
    }

    const children = this.cache.getChildren(this.ptyPid);
    const isBusy = children.length > 0;

    // Distinguish "no evidence" from "negative evidence". When the process
    // tree cache is currently in an error state and reports zero children,
    // that's blindness — an OS-level `ps` failure or fd starvation in the
    // utility process. Returning `no_agent` here would demote a confirmed
    // agent every OFF hysteresis window; returning `unknown` holds state
    // until the cache recovers. Precedent: #4973 (distinguish contexts so
    // a guard correct in one doesn't silently break another). #5809
    //
    // EXCEPTION: if fresh shell-command evidence exists, let the merge path
    // promote from it. Blind-`ps` + typed `claude` is the PRIMARY case this
    // feature exists for — holding `unknown` here would silently discard the
    // shell signal. Only when both signals are absent do we hold `unknown`.
    const cacheError = this.cache.getLastError();
    if (!isBusy && cacheError !== null) {
      const shellEvidenceValid = this.isShellCommandEvidenceValid(false);
      if (shellEvidenceValid) {
        return this.mergeWithShellEvidence(null, { isBusy: false, currentCommand: undefined });
      }
      return makeUnknownResult({ isBusy: false });
    }

    if (!isBusy) {
      // True absence of children with healthy cache → negative evidence. Let
      // merge logic below consider shell-command evidence before committing
      // no_agent.
      return this.mergeWithShellEvidence(null, { isBusy: false, currentCommand: undefined });
    }

    const processes: ChildProcess[] = children.map((p) => ({
      pid: p.pid,
      name: p.comm,
      command: p.command,
    }));

    let bestMatch: DetectedProcessCandidate | null = null;
    let order = 0;

    for (const proc of processes) {
      const candidate = this.buildDetectedCandidate(proc.name, proc.command, order++);
      if (candidate) {
        bestMatch = this.selectPreferredCandidate(bestMatch, candidate);
      }
    }

    // Grandchild fallback. Only run when direct children didn't produce an
    // identified agent — avoids showing a "node" badge for claude's Node
    // worker processes when the claude parent renamed its comm. Covers real
    // nesting: `zsh → npm → node /path/to/claude` for `npm run claude`.
    if (!bestMatch || bestMatch.priority > 0) {
      for (const child of children.slice(0, 10)) {
        const grandchildren = this.cache.getChildren(child.pid);
        for (const grandchild of grandchildren) {
          const candidate = this.buildDetectedCandidate(
            grandchild.comm,
            grandchild.command || grandchild.comm,
            order++
          );
          if (candidate) {
            bestMatch = this.selectPreferredCandidate(bestMatch, candidate);
          }
        }
      }
    }

    // Diagnostic: when we saw running processes but couldn't identify any of
    // them, log what the OS actually reported. Fires at most once per
    // unique (comm, command) tuple set so a persistent mystery process
    // doesn't spam — but any NEW mystery process gets surfaced.
    if (!bestMatch) {
      const signature = processes.map((p) => `${p.name}|${p.command ?? ""}`).join("/");
      if (signature !== this.lastUnknownSignature) {
        this.lastUnknownSignature = signature;
        console.warn(
          `[ProcessDetector ${this.terminalId.slice(-8)}] unmatched children of pid ${this.ptyPid}:`,
          processes
            .map(
              (p) => `pid=${p.pid} comm=${JSON.stringify(p.name)} argv0=${redactArgv(p.command)}`
            )
            .join(" | ")
        );
      }
    }

    const primaryProcess = processes[0];
    const primaryCommand = primaryProcess?.command;

    return this.mergeWithShellEvidence(bestMatch, {
      isBusy,
      currentCommand: bestMatch?.processCommand || primaryCommand,
    });
  }

  /**
   * Merge process-tree evidence (bestMatch from children scan) with any
   * injected shell-command evidence to produce the final DetectionResult.
   *
   * Rules — with the title-rewriting case as the primary motivating example:
   *   1. Both sources agree on agent identity → `agent` with
   *      `evidenceSource: "both"`.
   *   2. Process tree positively identifies a DIFFERENT agent than the shell
   *      → `ambiguous`. Two positive agent signals in conflict is genuinely
   *      uncertain; hold until one stabilises.
   *   3. Shell identifies an agent + tree shows a runtime/no match (the
   *      title-rewriting or blind-argv case) → `agent` with
   *      `evidenceSource: "shell_command"`. This is what #5809 is for —
   *      `node` or empty tree + `claude` in the shell must resolve to
   *      claude, not hold in limbo.
   *   4. Only process tree → `agent`/`no_agent` with
   *      `evidenceSource: "process_tree"`.
   *   5. Only shell evidence, tree says no_agent but shell is fresh → use
   *      shell identity (shell-command wins when tree is blind/empty).
   *   6. Non-agent process icon from shell (npm/docker/etc.) behaves the
   *      same way the process-tree icon would — it's a display hint, not
   *      an agent promotion — and is subordinated to any process-tree agent
   *      match.
   */
  private mergeWithShellEvidence(
    treeMatch: DetectedProcessCandidate | null,
    ctx: { isBusy: boolean; currentCommand?: string }
  ): DetectionResult {
    const shellIdentity = this.shellCommandIdentity;
    // Merge uses the wider expiry window (30 s) — shell evidence stays valid
    // for merging even after the 12 s sticky window closes. Sticky governs
    // off-streak suppression in detect(); merge governs whether the shell
    // signal can promote (no tree) or disagree (tree shows different agent).
    const shellEvidenceValid = this.isShellCommandEvidenceValid(ctx.isBusy);

    // Case A — tree has a positive agent match.
    if (treeMatch?.agentType) {
      if (shellEvidenceValid && shellIdentity?.agentType) {
        if (shellIdentity.agentType === treeMatch.agentType) {
          return makeAgentResult({
            agentType: treeMatch.agentType,
            processIconId: treeMatch.processIconId,
            processName: treeMatch.processName,
            isBusy: ctx.isBusy,
            currentCommand: ctx.currentCommand,
            evidenceSource: "both",
          });
        }
        // Two distinct positive agent identities — genuinely ambiguous. Hold.
        return makeAmbiguousResult({
          isBusy: ctx.isBusy,
          currentCommand: ctx.currentCommand,
        });
      }
      return makeAgentResult({
        agentType: treeMatch.agentType,
        processIconId: treeMatch.processIconId,
        processName: treeMatch.processName,
        isBusy: ctx.isBusy,
        currentCommand: ctx.currentCommand,
        evidenceSource: "process_tree",
      });
    }

    // Case B — no tree agent match, but shell is valid with an agent. The
    // title-rewriting CLI and blind-`ps` cases both land here.
    if (shellEvidenceValid && shellIdentity?.agentType) {
      return makeAgentResult({
        agentType: shellIdentity.agentType,
        processIconId: shellIdentity.processIconId ?? treeMatch?.processIconId,
        processName: shellIdentity.processName ?? treeMatch?.processName,
        isBusy: ctx.isBusy,
        currentCommand: this.shellCommandText ?? ctx.currentCommand,
        evidenceSource: "shell_command",
      });
    }

    // Case C — tree has a non-agent icon match (npm/docker/etc). Shell icon
    // is only consulted when tree has nothing at all.
    if (treeMatch?.processIconId) {
      return makeAgentResult({
        processIconId: treeMatch.processIconId,
        processName: treeMatch.processName,
        isBusy: ctx.isBusy,
        currentCommand: ctx.currentCommand,
        evidenceSource: "process_tree",
      });
    }

    // Case D — no tree evidence. If shell has a non-agent icon and is still
    // valid, surface it the same way a tree icon would be surfaced.
    if (shellEvidenceValid && shellIdentity?.processIconId) {
      return makeAgentResult({
        processIconId: shellIdentity.processIconId,
        processName: shellIdentity.processName,
        isBusy: ctx.isBusy,
        currentCommand: this.shellCommandText ?? ctx.currentCommand,
        evidenceSource: "shell_command",
      });
    }

    // Case E — no evidence from either source → genuine no_agent.
    return makeNoAgentResult({ isBusy: ctx.isBusy, currentCommand: ctx.currentCommand });
  }

  getLastDetected(): BuiltInAgentId | null {
    return this.lastDetected;
  }

  private getPtyChildCount(): number {
    try {
      return this.cache.getChildren(this.ptyPid).length;
    } catch {
      return 0;
    }
  }

  private isShellCommandEvidenceValid(_isBusy: boolean): boolean {
    const shellIdentity = this.shellCommandIdentity;
    if (shellIdentity === null) return false;
    if (shellIdentity.agentType) return true;
    if (Date.now() < this.shellCommandExpiresAt) return true;
    return false;
  }

  private normalizeProcessName(name: string): string {
    const basename = name.split(/[\\/]/).pop() || name;
    return basename.replace(/\.exe$/i, "");
  }

  private buildDetectedCandidate(
    processName: string,
    processCommand: string | undefined,
    order: number
  ): DetectedProcessCandidate | null {
    const normalizedName = this.normalizeProcessName(processName);
    const lowerName = normalizedName.toLowerCase();

    // Primary: match the process basename (comm). Works for native binaries,
    // package managers, and well-behaved CLIs that haven't rewritten their
    // process title.
    let agentType = AGENT_CLI_NAMES[lowerName];
    let processIconId = PROCESS_ICON_MAP[lowerName];
    let effectiveName = normalizedName;

    // Fallback: walk argv from `command`. Covers the Node/Python-hosted CLI
    // case — `comm` is the runtime ("node"), argv[1] is the script basename
    // ("claude" from `node /path/to/claude --resume`). This only helps when
    // the process has NOT rewritten its own title; if `process.title = ...`
    // was called, macOS `ps` reflects the rewritten argv and the original
    // script name is lost. That case needs a different mechanism (shell
    // integration / output pattern matching / native foreground probe).
    //
    // We scan ALL candidates and prefer an AGENT match over a process-icon
    // match, because argv[0] of a Node-hosted CLI is "node" (a runtime that
    // would match PROCESS_ICON_MAP but not AGENT_CLI_NAMES) and the agent
    // identity is in argv[1]. Stopping at the first icon hit would
    // misclassify `node /path/to/claude` as a generic Node process.
    if (!agentType && processCommand) {
      const candidates = extractCommandNameCandidates(processCommand);
      let iconMatch: { name: string; icon: string } | null = null;
      for (const candidate of candidates) {
        const lowerCandidate = candidate.toLowerCase();
        const candidateAgent = AGENT_CLI_NAMES[lowerCandidate];
        if (candidateAgent) {
          // Agent match wins — commit immediately and stop scanning.
          agentType = candidateAgent;
          processIconId = PROCESS_ICON_MAP[lowerCandidate] ?? processIconId;
          effectiveName = candidate;
          break;
        }
        if (!iconMatch) {
          const candidateIcon = PROCESS_ICON_MAP[lowerCandidate];
          if (candidateIcon) iconMatch = { name: candidate, icon: candidateIcon };
        }
      }
      // No agent found; fall back to the first icon match if we have one
      // AND the primary `comm` didn't already produce one. Example: bare
      // `python3 script.py` — primary matches python3→python, fallback
      // finds no agent in argv, we keep the python icon from primary.
      if (!agentType && !processIconId && iconMatch) {
        processIconId = iconMatch.icon;
        effectiveName = iconMatch.name;
      }
    }

    if (!agentType && !processIconId) {
      return null;
    }

    return {
      agentType,
      processIconId,
      processName: effectiveName,
      processCommand,
      priority: this.getDetectionPriority(agentType, processIconId),
      order,
    };
  }

  private selectPreferredCandidate(
    current: DetectedProcessCandidate | null,
    candidate: DetectedProcessCandidate
  ): DetectedProcessCandidate {
    if (!current) {
      return candidate;
    }

    if (candidate.priority < current.priority) {
      return candidate;
    }

    if (candidate.priority === current.priority && candidate.order < current.order) {
      return candidate;
    }

    return current;
  }

  private getDetectionPriority(agentType?: BuiltInAgentId, processIconId?: string): number {
    if (agentType) {
      return 0;
    }

    if (processIconId && PACKAGE_MANAGER_ICON_IDS.has(processIconId)) {
      return 1;
    }

    return 2;
  }
}

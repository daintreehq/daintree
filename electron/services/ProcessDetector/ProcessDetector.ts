import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";
import type { ProcessTreeCache } from "../ProcessTreeCache.js";
import { logDebug, logWarn } from "../../utils/logger.js";
import { logIdentityDebug } from "../pty/identityDebug.js";
import type { ChildProcess, DetectedProcessCandidate, CommandIdentity } from "./types.js";
import {
  makeAgentResult,
  makeNoAgentResult,
  makeUnknownResult,
  makeAmbiguousResult,
} from "./types.js";
import type { DetectionCallback } from "./types.js";
import type { DetectionResult, DetectionEvidenceSource } from "./types.js";
import { redactArgv } from "./commandParser.js";
import { buildDetectedCandidate, selectPreferredCandidate } from "./candidateHelpers.js";

export { type DetectionResult } from "./types.js";

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

  // When false, the "agent-requires-explicit-exit" demote-hold at the gating
  // path is bypassed for runtime-promoted plain terminals: the user typed the
  // CLI into a plain shell, so no durable launch anchor exists. After the user
  // Ctrl+Cs and the process tree empties, the chrome must demote even when
  // IdentityWatcher's prompt-return signal is delayed or suppressed (e.g.
  // when foreground PG snapshot reads briefly fail in CI). Toolbar/cold-
  // launched agents (`isLaunchAnchored=true`) preserve the existing hold so
  // transient process-tree blindness doesn't drop their branded chrome.
  private isLaunchAnchored: boolean;

  constructor(
    terminalId: string,
    spawnedAt: number,
    ptyPid: number,
    callback: DetectionCallback,
    cache: ProcessTreeCache,
    isLaunchAnchored: boolean = true
  ) {
    this.terminalId = terminalId;
    this.spawnedAt = spawnedAt;
    this.ptyPid = ptyPid;
    this.callback = callback;
    this.cache = cache;
    this.isLaunchAnchored = isLaunchAnchored;
  }

  /**
   * Update launch-anchor state. Runtime promotion of a plain terminal
   * (`launchAgentId` was undefined when the detector was created, then a
   * subsequent `setLaunchAgentId` call attached one) keeps the explicit-exit
   * guard in step with the live anchor.
   */
  setLaunchAnchored(isLaunchAnchored: boolean): void {
    this.isLaunchAnchored = isLaunchAnchored;
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
        } else if (committedAgent !== null && this.isLaunchAnchored) {
          // Launch-anchored agents are sticky until an explicit lifecycle
          // signal arrives. Process-tree absence is too weak: idle CLIs can
          // rewrite argv/comm, temporarily hide children, or show prompt-like
          // TUI elements while still running. Prompt-return clears via
          // clearShellCommandEvidence("prompt-return"). Runtime-promoted
          // agents (no launchAgentId) fall through to the offStreak path
          // below so process-tree absence eventually demotes them — without
          // this, a delayed or suppressed prompt-return signal would strand
          // the chrome on the dead agent's icon.
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
      const candidate = buildDetectedCandidate(proc.name, proc.command, order++);
      if (candidate) {
        bestMatch = selectPreferredCandidate(bestMatch, candidate);
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
          const candidate = buildDetectedCandidate(
            grandchild.comm,
            grandchild.command || grandchild.comm,
            order++
          );
          if (candidate) {
            bestMatch = selectPreferredCandidate(bestMatch, candidate);
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
   * A. Both sources agree on agent identity → `agent` with
   *    `evidenceSource: "both"`.
   * B. Process tree positively identifies a DIFFERENT agent than the shell
   *    → `ambiguous`. Two positive agent signals in conflict is genuinely
   *    uncertain; hold until one stabilises.
   * C. Shell identifies an agent + tree shows a runtime/no match (the
   *    title-rewriting or blind-argv case) → `agent` with
   *    `evidenceSource: "shell_command"`. This is what #5809 is for —
   *    `node` or empty tree + `claude` in the shell must resolve to
   *    claude, not hold in limbo.
   * D. Only process tree → `agent`/`no_agent` with
   *    `evidenceSource: "process_tree"`.
   * E. Only shell evidence, tree says no_agent but shell is fresh → use
   *    shell identity (shell-command wins when tree is blind/empty).
   * F. Non-agent process icon from shell (npm/docker/etc.) behaves the
   *    same way the process-tree icon would — it's a display hint, not
   *    an agent promotion — and is subordinated to any process-tree agent
   *    match.
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
      // Runtime-promoted demote escape hatch. The "shell evidence wins on
      // empty tree" rule exists for title-rewriting CLIs where the agent is
      // alive but invisible to `ps`. For runtime-promoted plain terminals
      // (no launch anchor) AFTER an agent has already been committed, that
      // anchor becomes too sticky: the user Ctrl+C'd the CLI in a plain
      // shell and tree absence is now the authoritative lifecycle signal.
      // Stop overriding tree-empty with stale shell evidence in that case;
      // let off-streak hysteresis demote. Bootstrap promotion (no commit
      // yet, `lastDetected === null`) still goes through normally so a
      // typed `claude` in an empty tree can still commit before the agent
      // process appears in `ps`.
      const cacheHealthy = this.cache.getLastError() === null;
      if (
        !this.isLaunchAnchored &&
        this.lastDetected !== null &&
        !ctx.isBusy &&
        treeMatch === null &&
        cacheHealthy
      ) {
        return makeNoAgentResult({
          isBusy: ctx.isBusy,
          currentCommand: ctx.currentCommand,
        });
      }
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
}

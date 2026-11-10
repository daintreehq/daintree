import { existsSync } from "fs";
import { stat } from "fs/promises";
import { resolve as pathResolve } from "path";
import { createHardenedGit } from "../utils/hardenedGit.js";
import { getGitCommonDir } from "../utils/gitUtils.js";
import {
  matchProviderForRemoteUrl,
  type ForgeProviderMatcher,
} from "../../shared/utils/forgeHostnames.js";
import {
  resolveForgeRemote,
  type ForgeRemoteCandidate,
} from "../../shared/utils/forgeRemoteSelection.js";
import type { WorktreeMonitor } from "./WorktreeMonitor.js";

// Coalescing window for `.git/config` writes (#11155). Every worktree sharing
// the common dir reports the same write, and git itself writes config as
// lock-then-rename (two events), so a short trailing debounce collapses the
// burst into one `getRemotes()` spawn.
const FORGE_REMOTE_REPROBE_DEBOUNCE_MS = 250;
// Re-arm budget for a settings/matcher-driven reselect whose probe was
// superseded or failed. Bounded because a deleted repo fails enumeration
// forever and nothing else retries this path (`.git/config` never changed).
const FORGE_RESELECT_MAX_RETRIES = 3;

// Backstop cadence for the config fingerprint check when the git watcher is
// disabled or has silently degraded. A stat, not a subprocess.
const FORGE_CONFIG_POLL_INTERVAL_MS = 5 * 60 * 1000;

// How long a resume waits for the remotes to settle before restarting PR
// polling anyway. A stat on a dead mount never returns, and polling stranded
// behind it would be worse than one check against a possibly stale provider.
const FORGE_RESUME_SETTLE_TIMEOUT_MS = 5_000;

// One read of the repo's remote table. Raw rather than the selected URL, so a
// later `forgeRemote` or matcher change selects from it without re-reading git.
interface ForgeRemoteTable {
  remotes: ForgeRemoteCandidate[];
  signature: string;
}

interface ForgeRemoteRead {
  promise: Promise<ForgeRemoteTable | null>;
  // Set once the read lands, and only while it still owns the slot.
  table: ForgeRemoteTable | null;
  // Lost the slot before landing. A stranded read's failure is not the repo's
  // answer: the read that replaced it may itself have failed and fanned out
  // nothing.
  stranded: boolean;
}

// Everything detection reads from or pushes to a monitor.
export type ForgeRemoteMonitor = Pick<
  WorktreeMonitor,
  "id" | "isRunning" | "remoteFetchUrl" | "setRemoteFetchUrl" | "setMatchedForgeProviderId"
>;

export interface ForgeRemoteDetectorHost {
  getProjectRootPath(): string | null;
  getMonitor(id: string): ForgeRemoteMonitor | undefined;
  getMonitors(): Iterable<ForgeRemoteMonitor>;
  // `false` only once a load found no repository; `null` before the first load.
  getGitBacked(): boolean | null;
  isBackgrounded(): boolean;
  isShutDown(): boolean;
  // The remote table changed. Only the fact crosses: the URLs and the
  // signature stay in this process.
  onRemotesChanged(): void;
}

/**
 * Repo-level forge remote detection (#11155, #11408, #16427): which remote each
 * monitor routes through, and which registered provider it matches. Owns the
 * remote table, the change baseline and every timer that keeps them current;
 * the host supplies the project and its monitors.
 */
export class ForgeRemoteDetector {
  // Provider hostname-matcher table relayed from main's forge registry.
  // Empty until the first relay lands (after plugin load), so monitors start
  // unmatched and re-resolve when the table arrives or changes.
  private providerMatchers: ForgeProviderMatcher[] = [];
  // Repo-level forge-remote state (#11155). Remotes live in the shared
  // `.git/config`, so every worktree's watcher reports the same write — this
  // coalesces them into ONE probe and fans the result out to all
  // monitors. `signature` is the last-seen remote table (names +
  // fetch URLs, host-local and never transmitted — remote URLs can embed
  // credentials). Events fire only when it genuinely changes, so the unrelated
  // config writes that already wake the watcher (`git push -u`,
  // `branch --set-upstream-to`) cost nothing and cannot churn the provider.
  private signature: string | null = null;
  // The repo's remote table, shared by every consumer that only needs to know
  // what the remotes ARE: monitor starts, reselects (#16427). Pending or
  // landed. Kept apart from `signature`, which only the load-time
  // read and the reprobe may set — a monitor-start read can race the user.
  // Replaced by every reprobe that finds the config moved, so a read the slot
  // no longer holds is stale and must not be applied.
  private remoteRead: ForgeRemoteRead | null = null;
  // The main worktree as this host's own enumeration listed it — never taken
  // from a monitor, which may belong to a project being switched away from.
  // Reads fall back to it once the project root, which can be a linked
  // worktree, has been removed.
  private mainWorktreePath: string | null = null;
  // The project's selected forge remote *name* (#11408). Kept here
  // (not just handed to `pullRequestService`) because `readRemotes` needs
  // it to pick the same remote the toolbar routes through — otherwise the
  // worktree cards probe `origin` while the toolbar talks to `upstream`.
  private remoteName: string | null = null;
  private reselectSeq = 0;
  private reselectTimer: NodeJS.Timeout | null = null;
  private reselectRetries = 0;
  private probeSeq = 0;
  private reprobeTimer: NodeJS.Timeout | null = null;
  // Bumped whenever a `.git/config` write is OBSERVED. A baseline read that
  // spans a bump may already contain the change it was meant to precede, so it
  // is discarded rather than seeded.
  private configEpoch = 0;
  // Watcher-independent backstop: `GitFileWatcher` swallows `fs.watch` failures
  // (silent fallback to polling) and Linux inotify exhaustion is a live failure
  // mode, so a repo can miss the config event entirely. Costs one stat per
  // interval; the git subprocess runs only when the fingerprint actually moved.
  private configPollTimer: NodeJS.Timeout | null = null;
  private configFingerprint: string | null = null;
  // Detection runs for the loaded project; the backstop timer only while the
  // host is foregrounded. Tracked apart so a pause can drop the timer without
  // letting a later load mistake the missing timer for "never started".
  private active = false;
  private latestReprobe: Promise<void> | null = null;

  constructor(private readonly host: ForgeRemoteDetectorHost) {}

  /** The project's `forgeRemote` setting as a load hands it over. */
  setRemoteName(name: string | null): void {
    this.remoteName = name;
  }

  /** A `forgeRemote` settings push. */
  updateRemoteName(name: string | null): void {
    const remoteSelectionChanged = name !== this.remoteName;
    this.remoteName = name;
    // The remote table on disk is unchanged, so the signature-gated reprobe
    // would never fire — but the remote we *select* from it just moved, which
    // changes the matched provider for every monitor (#11408).
    if (remoteSelectionChanged) {
      this.reselectRetries = 0;
      void this.reselect();
    }
  }

  setMainWorktreePath(path: string | null): void {
    this.mainWorktreePath = path;
  }

  /**
   * The host was backgrounded. The pool keeps a backgrounded host for as long
   * as its project's view is cached (#12519), so the config backstop would
   * otherwise tick for hours in a host nothing is looking at. Nothing else
   * watches `.git/config` while paused either — `resume()` reprobes once to
   * catch what it missed.
   */
  pause(): void {
    this.disarmBackstop();
  }

  /**
   * The host was foregrounded after a pause. Returns once the remotes have
   * settled, or after a deadline, so the PR poller can wait to restart on the
   * provider it resolved before the pause: nothing watched `.git/config`
   * meanwhile. Stat-gated, so an unchanged config costs one stat and no git; a
   * changed one signals the change, which drops that resolution first. `null`
   * when no project's detection is running.
   */
  resume(): Promise<void> | null {
    if (!this.active) return null;
    this.armBackstop();
    return new Promise<void>((resolve) => {
      const deadline = setTimeout(resolve, FORGE_RESUME_SETTLE_TIMEOUT_MS);
      deadline.unref?.();
      void this.settleRemotes().finally(() => {
        clearTimeout(deadline);
        resolve();
      });
    });
  }

  /**
   * Read the repo's remote table once, with a stable signature of every
   * name→fetch-URL pair, used to tell a real remote change from an unrelated
   * `.git/config` write. Both stay in this process — remote URLs can carry
   * embedded credentials.
   */
  private async readRemotes(cwd: string): Promise<ForgeRemoteTable | null> {
    try {
      const git = await createHardenedGit(cwd);
      const remotes = (await git.getRemotes(true)).map((r) => ({
        name: r.name,
        fetchUrl: r.refs?.fetch ?? "",
      }));
      // Deliberately covers ALL remotes, not just the one selected: it answers
      // "did the remote table change", independent of which entry we route
      // through.
      const signature = remotes
        .map((remote) => `${remote.name}\x00${remote.fetchUrl}`)
        .sort()
        .join("\x01");
      return { remotes, signature };
    } catch {
      // Remote probe is best-effort; keep the affordance hidden on failure.
      return null;
    }
  }

  /**
   * Select the forge remote from a table and push it, with its matched
   * provider, to the given monitors. Selection runs here rather than at read
   * time so it always uses the current `forgeRemote` setting and matcher table.
   */
  private applyTable(table: ForgeRemoteTable, monitors: Iterable<ForgeRemoteMonitor>): void {
    // Honours the project's `forgeRemote` setting (#11408). A
    // configured-but-missing remote selects nothing, leaving the affordance
    // hidden rather than silently probing a different repo.
    const { remote: selected } = resolveForgeRemote({
      remotes: table.remotes,
      forgeRemote: this.remoteName,
      // The host has no provider registry — it matches against the matcher
      // table main relays via `setProviderMatchers`.
      isSupportedRemote: (url) => matchProviderForRemoteUrl(url, this.providerMatchers) !== null,
    });
    const fetchUrl = selected?.fetchUrl;
    const matchedProviderId = fetchUrl
      ? matchProviderForRemoteUrl(fetchUrl, this.providerMatchers)
      : null;
    for (const monitor of monitors) {
      if (!monitor.isRunning) continue;
      monitor.setRemoteFetchUrl(fetchUrl);
      monitor.setMatchedForgeProviderId(matchedProviderId);
    }
  }

  /**
   * Install `read` as the shared remote table. The slot is taken
   * synchronously, so a consumer arriving mid-read joins it instead of
   * spawning a second `git remote`. A failed read frees the slot for the
   * next consumer; a read that lost the slot publishes nothing.
   */
  private beginRemoteRead(read: () => Promise<ForgeRemoteTable | null>): ForgeRemoteRead {
    const settle = (table: ForgeRemoteTable | null): ForgeRemoteTable | null => {
      if (this.remoteRead !== slot) slot.stranded = true;
      else if (table) slot.table = table;
      else this.remoteRead = null;
      return table;
    };
    const slot: ForgeRemoteRead = {
      promise: read().then(settle, () => settle(null)),
      table: null,
      stranded: false,
    };
    this.remoteRead = slot;
    return slot;
  }

  /**
   * Where remote reads run: never a monitor's path. An install that straddled
   * a project switch can leave the old project's monitor running, and a read
   * from its path would hand that repo's remotes to every incoming monitor.
   */
  private remoteCwd(): string | null {
    const root = this.host.getProjectRootPath();
    if (!root) return null;
    // The root first: it is where the load-time read ran, and a linked
    // worktree's own `config.worktree` can define remotes the main one lacks.
    if (this.mainWorktreePath && !existsSync(root)) return this.mainWorktreePath;
    return root;
  }

  /** The shared remote table, starting a read only when none is held. */
  private sharedRemoteRead(): ForgeRemoteRead | null {
    if (this.remoteRead) return this.remoteRead;
    const cwd = this.remoteCwd();
    if (!cwd) return null;
    return this.beginRemoteRead(() => this.readRemotes(cwd));
  }

  /**
   * Resolve a newly started monitor's forge remote from the shared table,
   * remember it on the monitor, and match it against the relayed
   * provider-matcher table. Off the critical path — failures are silent (the
   * affordance simply stays hidden, which matches the unmatched-remote
   * behavior). The remembered URL lets `setProviderMatchers` re-match
   * without re-reading git.
   *
   * Every monitor of a load shares one read, and a worktree added later
   * resolves from the table already held (#16427).
   */
  async probeMonitor(monitor: ForgeRemoteMonitor): Promise<void> {
    // A second pass covers a read that did not settle this monitor: one
    // replaced while it waited (its table may predate the replacement's
    // fan-out, so applying it would overwrite that), or one it only joined
    // that came back empty — the load's read, failed or discarded. A failed
    // read this monitor started itself, and still held, is final, as before,
    // so a repo whose enumeration keeps failing costs one read per monitor.
    for (let pass = 0; pass < 2; pass++) {
      // Checked before every read: a monitor torn down by a project switch must
      // not start one.
      if (this.host.getMonitor(monitor.id) !== monitor || !monitor.isRunning) return;
      if (this.host.isShutDown()) return;
      const joined = this.remoteRead !== null;
      const read = this.sharedRemoteRead();
      if (!read) return;
      const table = await read.promise;
      if (table && this.remoteRead === read) {
        if (this.host.getMonitor(monitor.id) === monitor) {
          this.applyTable(table, [monitor]);
        }
        return;
      }
      if (!table && !joined && !read.stranded) return;
    }
    // Deliberately never seeds `signature`. A monitor start read
    // races the user: it can complete AFTER a `git remote add` and would then
    // record the post-change remotes as the "before" baseline, leaving the
    // reprobe with an equal signature and nothing to emit — the toolbar would
    // stay stale for exactly the case this feature exists to catch. The
    // baseline is seeded once at load instead (`start`).
  }

  /**
   * A worktree's `.git/config` was written. Remotes are repo-level, so every
   * sibling worktree reports the same write (and git writes config as
   * lock-then-rename) — a trailing debounce collapses the burst into one probe.
   */
  scheduleReprobe(opts: { observedConfigWrite: boolean }): void {
    if (this.host.isShutDown()) return;
    // Bump on a real observed write even when a reprobe is already pending: it
    // marks an in-flight baseline seed as spanning the write, so it can't record
    // a snapshot that already absorbed the change. The backstop tick observes
    // nothing, so it must not invalidate the seed.
    if (opts.observedConfigWrite) this.configEpoch++;
    if (this.reprobeTimer) return;
    this.reprobeTimer = setTimeout(() => {
      this.reprobeTimer = null;
      void this.reprobe();
    }, FORGE_REMOTE_REPROBE_DEBOUNCE_MS);
  }

  /**
   * Re-read the repo's remotes after a `.git/config` write and, when the remote
   * table actually changed, re-resolve every monitor's forge affordance and
   * signal both the in-process PR poller and the renderer (#11155). An
   * unchanged signature emits nothing — that restraint is what keeps
   * `PullRequestService`'s no-match pause (#9997) meaningful, since the same
   * config file is written by `git push -u` on every first push.
   */
  private reprobe(): Promise<void> {
    const probe = this.runReprobe();
    this.latestReprobe = probe;
    return probe;
  }

  /**
   * Resolve once the newest remote probe has finished. A probe superseded
   * mid-read returns at its sequence check before its replacement has read
   * anything, so waiting on the first one alone would release early.
   */
  private async settleRemotes(): Promise<void> {
    let probe = this.reprobe();
    for (;;) {
      await probe.catch(() => {});
      const latest = this.latestReprobe;
      if (latest === null || latest === probe) return;
      probe = latest;
    }
  }

  private async runReprobe(): Promise<void> {
    const cwd = this.remoteCwd();
    if (!cwd) return;
    const seq = ++this.probeSeq;

    // Cheap gate in front of the subprocess. Two callers land here — the git
    // watcher and the 5-minute backstop — and neither proves the remotes moved:
    // `fs.watch` may report a change with NO filename (so we conservatively
    // assume config), and the backstop fires on a timer. Without this gate a
    // repo emitting unnamed `.git/` events would spawn `git remote` every
    // debounce window.
    //
    // Safe to gate on, because git writes `.git/config` lock-then-rename — a
    // real `git remote add/set-url/remove` ALWAYS lands a new inode, so it can
    // never be mistaken for "unchanged". Stat failure fails open (probe anyway).
    const fingerprint = await this.readConfigFingerprint();
    if (seq !== this.probeSeq) return;
    if (fingerprint !== null && fingerprint === this.configFingerprint) return;

    // Always a fresh read, never the shared table: the fingerprint just said
    // the config moved. Replacing the slot also strands any older read still
    // in flight, so it can no longer land on a monitor after this fan-out.
    const probed = await this.beginRemoteRead(() => this.readRemotes(cwd)).promise;
    // A dispose (or a newer probe) landed while git ran: the monitors this one
    // would touch may already be stopped, and its read is no longer the truth.
    if (!probed || seq !== this.probeSeq) return;
    if (this.host.isShutDown()) return;

    // Consume the fingerprint only now that this probe has actually READ the
    // remotes that go with it. Recording it up front (before the git read) loses
    // changes two ways: a superseding probe would see the fingerprint already
    // consumed and bail while the superseded probe dies on the seq check, and a
    // transient git failure would leave the change permanently marked as seen.
    this.configFingerprint = fingerprint;

    this.applyTable(probed, this.host.getMonitors());

    if (probed.signature === this.signature) return;
    this.signature = probed.signature;

    this.host.onRemotesChanged();
  }

  /**
   * Identity fingerprint of `<commonDir>/config`, or null when it can't be read.
   * Includes the inode: git writes config lock-then-rename, so every real
   * `git remote` mutation lands a NEW inode. That makes the fingerprint a
   * trustworthy "did this file actually change" gate even on filesystems whose
   * timestamp granularity is too coarse to catch a same-size rewrite.
   */
  private async readConfigFingerprint(): Promise<string | null> {
    const rootPath = this.host.getProjectRootPath();
    if (!rootPath) return null;
    try {
      const commonDir = await getGitCommonDir(rootPath, { logErrors: false });
      if (!commonDir) return null;
      const stats = await stat(pathResolve(commonDir, "config"));
      return `${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
    } catch {
      return null;
    }
  }

  /**
   * Seed the change baseline and arm the watcher-independent backstop. Called
   * at project load, before any monitor (and therefore any git watcher) starts.
   *
   * The load-time read is the ONLY one allowed to establish the "before"
   * snapshot: it provably precedes the watcher, whereas a per-monitor start
   * probe races the user and can absorb the very `git remote add` we need to
   * detect. `??=` keeps a reprobe that already landed from being overwritten by
   * this slower read.
   */
  start(): void {
    if (this.active) return;
    const rootPath = this.host.getProjectRootPath();
    if (!rootPath) return;
    this.active = true;

    // Bumped, not just read: the seed replaces whatever holds the slot, and a
    // reselect read started since the last stop (the load assigns the root
    // before it gets here) would otherwise pass its sequence check and apply
    // a table older than this one, after the seed has already consumed the
    // fingerprint that would have flagged it.
    const seq = ++this.probeSeq;
    const epoch = this.configEpoch;
    // Held in the shared slot, so the monitors this load installs take their
    // remotes from this one read rather than one `git remote` each (#16427).
    // The table is published only when the baseline below is trustworthy; a
    // discarded read frees the slot and the monitors share one fresh read.
    this.beginRemoteRead(async () => {
      // stat → read → stat. The remote table and the fingerprint must describe
      // the SAME config, or the pair is incoherent: pre-change remotes stamped
      // with a post-change fingerprint would make the backstop consider the
      // change already seen and never emit it. Reading them concurrently cannot
      // guarantee that; bracketing the git read with two stats can.
      const before = await this.readConfigFingerprint();
      const probed = await this.readRemotes(rootPath);
      const after = await this.readConfigFingerprint();

      // Discard when: the project unloaded mid-read, a config write was observed
      // mid-read, or the config moved between the stats (so this read may
      // already contain the change it is supposed to precede). Leaving the
      // baseline null is the safe failure — the next reprobe then sees
      // `signature !== null` and emits.
      if (seq !== this.probeSeq || epoch !== this.configEpoch) return null;
      if (before !== after) return null;
      if (probed) this.signature ??= probed.signature;
      this.configFingerprint ??= after;
      return probed;
    });

    if (!this.host.isBackgrounded()) this.armBackstop();
  }

  private armBackstop(): void {
    if (this.configPollTimer) return;
    // The backstop only has to WAKE the reprobe — the reprobe itself stats the
    // config and skips the git spawn when nothing moved, so an idle tick costs
    // one stat.
    this.configPollTimer = setInterval(() => {
      this.scheduleReprobe({ observedConfigWrite: false });
    }, FORGE_CONFIG_POLL_INTERVAL_MS);
    this.configPollTimer.unref?.();
  }

  private disarmBackstop(): void {
    if (this.configPollTimer) {
      clearInterval(this.configPollTimer);
      this.configPollTimer = null;
    }
  }

  stop(): void {
    this.active = false;
    this.disarmBackstop();
    if (this.reselectTimer) {
      clearTimeout(this.reselectTimer);
      this.reselectTimer = null;
    }
    if (this.reprobeTimer) {
      clearTimeout(this.reprobeTimer);
      this.reprobeTimer = null;
    }
    // Invalidate every in-flight read (baseline seed and reprobe alike) so a
    // late completion can't touch stopped monitors, seed the incoming project's
    // baseline, or signal on behalf of a project that is no longer loaded.
    this.probeSeq++;
    this.signature = null;
    this.configFingerprint = null;
    this.remoteRead = null;
    this.mainWorktreePath = null;
    // Ends an in-flight reselect outright: its bounded retry would otherwise
    // re-arm against whatever project loads next.
    this.reselectSeq++;
  }

  /**
   * Store the relayed provider-matcher table and re-resolve every running
   * monitor's matched provider id. The table arrives async after plugin load
   * (and again on registry changes), so monitors that started unmatched gain
   * their provider id here once the owning plugin registers.
   */
  setProviderMatchers(matchers: ForgeProviderMatcher[]): void {
    this.providerMatchers = Array.isArray(matchers) ? matchers : [];
    for (const monitor of this.host.getMonitors()) {
      if (!monitor.isRunning) continue;
      const fetchUrl = monitor.remoteFetchUrl;
      monitor.setMatchedForgeProviderId(
        fetchUrl ? matchProviderForRemoteUrl(fetchUrl, this.providerMatchers) : null
      );
    }
    // Re-matching the REMEMBERED url is not enough (#11408): which remote is
    // selected depends on the matcher table too. At cold start the table is
    // empty, so auto-detect ranks by name alone and can settle on a remote no
    // provider ends up supporting — re-matching that URL would leave the
    // affordance hidden forever while a sibling remote was usable all along.
    // Same story when enabling or disabling a provider plugin at runtime.
    //
    // Coalesced: the relay pushes on EVERY registry change, so plugin init
    // arrives as a burst of calls that would otherwise be one `git remote -v`
    // each. Mirrors the reprobe debounce, minus its config-fingerprint gate —
    // nothing wrote `.git/config` here, only the matcher table moved.
    this.reselectRetries = 0;
    this.scheduleReselect();
  }

  /**
   * Re-run remote selection after the `forgeRemote` setting changed. Unlike
   * `runReprobe` this deliberately skips the `.git/config`
   * fingerprint and signature gates: neither moved, only the choice did.
   */
  private scheduleReselect(): void {
    // A folder with no repository has no remotes to reselect from, and the
    // shared read falls back to the project root — so without this the
    // matcher relay would spawn `git remote -v` there and, on its bounded
    // re-arm, up to three more times per registry change (#11405 × #11408).
    // Left at `=== false` where the monitor-minting guards moved to `!== true`:
    // a matcher push reaching a host whose probe failed can still spawn one
    // bounded, read-only `git remote -v` against that path. It fails fast and
    // harmlessly, and tightening it here would block the legitimate cold-start
    // reselect that lands before a load completes.
    if (this.host.getGitBacked() === false) return;
    if (this.host.isShutDown()) return;
    if (this.reselectTimer) return;
    this.reselectTimer = setTimeout(() => {
      this.reselectTimer = null;
      void this.reselect();
    }, FORGE_REMOTE_REPROBE_DEBOUNCE_MS);
  }

  private async reselect(): Promise<void> {
    // Guarded here as well as in `scheduleReselect`: `updateRemoteName`
    // calls this one directly, so the debounced path is not the only way in.
    if (this.host.getGitBacked() === false) return;
    // Its OWN sequence — it only makes two rapid setting changes land in order.
    const seq = ++this.reselectSeq;
    // Snapshot WITHOUT bumping: bumping `probeSeq` would cancel an
    // in-flight `runReprobe` before it consumed its fingerprint,
    // silently dropping a real `.git/config` change until the next watcher
    // event. Yielding to it instead is safe — a reprobe re-reads the table
    // with the current `remoteName`, so its result already reflects this
    // settings change. The same check covers teardown and project switch,
    // which bump the probe seq in `stop`.
    const probeSeq = this.probeSeq;
    // The shared table, not a fresh read: only the selection inputs moved, and
    // a matcher relay at plugin load would otherwise spawn `git remote` on top
    // of the load's own read.
    const read = this.sharedRemoteRead();
    if (!read) return;
    const probed = await read.promise;
    // A newer reselect is already authoritative — drop this one outright.
    if (seq !== this.reselectSeq) return;
    // The other two bail-outs are NOT terminal, so they re-arm the debounce
    // instead of returning. A config probe that superseded us may itself have
    // exited at its fingerprint gate without ever reading the remotes, and a
    // failed enumeration leaves monitors pointing at the previously selected
    // remote. Either way the new selection would otherwise never be applied,
    // and nothing else would retry: `.git/config` did not change, so the
    // fingerprint-gated backstop skips this repo entirely.
    if (!probed || probeSeq !== this.probeSeq) {
      // Bounded: a repo that was deleted under us fails enumeration forever,
      // and an unbounded re-arm would spawn a git process every debounce tick
      // for the life of the host.
      if (this.reselectRetries < FORGE_RESELECT_MAX_RETRIES) {
        this.reselectRetries++;
        this.scheduleReselect();
      }
      return;
    }
    this.reselectRetries = 0;
    if (this.host.isShutDown()) return;

    this.applyTable(probed, this.host.getMonitors());
  }
}

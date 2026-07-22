import type {
  PluginInstallPhase,
  PluginInstallProgressEvent,
} from "../../../shared/types/plugin.js";

/**
 * Trailing coalesce window for archive-entry updates (#11302). Extraction can
 * fire hundreds of entries in a few milliseconds; forwarding each one would
 * flood the IPC bridge and thrash the renderer for detail nobody can read.
 * Phase changes bypass this — they're rare and are the part users act on.
 */
export const PLUGIN_INSTALL_PROGRESS_THROTTLE_MS = 150;

/**
 * The abort `reason` for a user-initiated cancel. Carried through
 * `AbortSignal.any` composition so the installer can tell "cancelled" apart
 * from a stall or the extraction deadline and return `{ status: "cancelled" }`
 * instead of a failure the user never caused.
 */
export const PLUGIN_INSTALL_CANCELLED_REASON = "plugin-install-cancelled";

/** True when `err` is the abort reason {@link PluginInstallJobRegistry.cancel} raises. */
export function isInstallCancellation(err: unknown): boolean {
  return err instanceof Error && err.message === PLUGIN_INSTALL_CANCELLED_REASON;
}

type Emit = (event: PluginInstallProgressEvent) => void;

interface JobRecord {
  controller: AbortController;
  emit: Emit;
  /** Flipped false at the commit point; a cancel after that is refused. */
  cancellable: boolean;
  phase: PluginInstallPhase;
  /** Pending trailing entry emission, if any. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The most recent entry seen while the trailing timer was armed. */
  pendingEntry: string | null;
  lastEntryAt: number;
}

/**
 * In-flight plugin installs that can report progress and be cancelled (#11302).
 *
 * Deliberately standalone rather than state on `PluginService`: the IPC handler
 * layer loads the plugin service lazily, and the install-from-URL download leg
 * needs the job's `AbortSignal` *before* the installer is ever reached. A small
 * module-scoped registry lets the handler, the download, and the installer share
 * one controller without any of them importing each other.
 *
 * Records are keyed by a caller-minted job id and live exactly as long as the
 * install call that registered them — {@link begin} is always paired with a
 * {@link end} in the caller's `finally`. {@link cancel} only aborts the
 * controller; it never touches the staging directory or the install lock,
 * because the installer's own `finally` already owns both and reaping them from
 * the outside would race a write still in flight.
 */
export class PluginInstallJobRegistry {
  private readonly jobs = new Map<string, JobRecord>();

  /**
   * Register a job and return its cancellation signal. Re-registering a live id
   * is a caller bug (ids are UUIDs), so the existing record wins and the new
   * caller silently gets no progress rather than hijacking someone else's job.
   */
  begin(jobId: string, emit: Emit): AbortSignal | null {
    if (this.jobs.has(jobId)) return null;
    const controller = new AbortController();
    this.jobs.set(jobId, {
      controller,
      emit,
      cancellable: true,
      phase: "extracting",
      timer: null,
      pendingEntry: null,
      lastEntryAt: 0,
    });
    return controller.signal;
  }

  /** The live signal for `jobId`, or null if it isn't registered. */
  signal(jobId: string | undefined): AbortSignal | undefined {
    if (!jobId) return undefined;
    return this.jobs.get(jobId)?.controller.signal;
  }

  /**
   * Move a job to `phase` and push it immediately. Phase transitions are the
   * coarse, user-meaningful events, so they're never coalesced — and any entry
   * still queued behind the throttle is dropped, since it belongs to the phase
   * being left.
   */
  setPhase(jobId: string | undefined, phase: PluginInstallPhase): void {
    const job = jobId ? this.jobs.get(jobId) : undefined;
    if (!job) return;
    this.clearTimer(job);
    job.phase = phase;
    job.emit({ jobId: jobId!, phase, cancellable: job.cancellable });
  }

  /**
   * Report the archive entry currently being extracted. Leading-edge immediate,
   * then trailing-edge coalesced, so the first entry shows instantly and a burst
   * settles on the last one instead of dropping it.
   */
  reportEntry(jobId: string | undefined, entry: string): void {
    const job = jobId ? this.jobs.get(jobId) : undefined;
    if (!job) return;
    const now = Date.now();
    if (job.timer === null && now - job.lastEntryAt >= PLUGIN_INSTALL_PROGRESS_THROTTLE_MS) {
      job.lastEntryAt = now;
      job.emit({ jobId: jobId!, phase: job.phase, entry, cancellable: job.cancellable });
      return;
    }
    job.pendingEntry = entry;
    job.timer ??= setTimeout(() => {
      job.timer = null;
      const pending = job.pendingEntry;
      job.pendingEntry = null;
      if (pending === null) return;
      job.lastEntryAt = Date.now();
      job.emit({ jobId: jobId!, phase: job.phase, entry: pending, cancellable: job.cancellable });
    }, PLUGIN_INSTALL_PROGRESS_THROTTLE_MS);
  }

  /**
   * Close the cancellation window before the irreversible swap begins. Returns
   * false if the job was already cancelled, so the installer can bail out rather
   * than commit an install the user just aborted — the check and the flip happen
   * together here so a cancel can't land in between.
   */
  commit(jobId: string | undefined): boolean {
    const job = jobId ? this.jobs.get(jobId) : undefined;
    if (!job) return true;
    if (job.controller.signal.aborted) return false;
    job.cancellable = false;
    return true;
  }

  /** Whether `jobId` is registered and still accepting a cancel. */
  isCancellable(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    return job !== undefined && job.cancellable && !job.controller.signal.aborted;
  }

  /**
   * Abort the job. Returns false for an unknown job or one that has already
   * passed the commit point — the caller surfaces that as "too late to cancel"
   * rather than pretending it worked.
   */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !job.cancellable) return false;
    if (job.controller.signal.aborted) return false;
    this.clearTimer(job);
    job.controller.abort(new Error(PLUGIN_INSTALL_CANCELLED_REASON));
    return true;
  }

  /** Drop the record and any pending trailing emission. Idempotent. */
  end(jobId: string | undefined): void {
    const job = jobId ? this.jobs.get(jobId) : undefined;
    if (!job) return;
    this.clearTimer(job);
    this.jobs.delete(jobId!);
  }

  /** Live job count — for tests asserting nothing leaks. */
  get size(): number {
    return this.jobs.size;
  }

  private clearTimer(job: JobRecord): void {
    if (job.timer !== null) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    job.pendingEntry = null;
  }
}

/** Process-wide registry — installs are serialized by `install.lock` regardless. */
export const pluginInstallJobs = new PluginInstallJobRegistry();

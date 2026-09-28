import { app, type Details, type RenderProcessGoneDetails, type WebContents } from "electron";
import { createLogger } from "../utils/logger.js";
import { getActiveShutdown } from "../lifecycle/shutdownCoordinator.js";
import { describeProcessDeath, isExternalKill } from "./processDeathDescription.js";
import { getTerminationIntent } from "./processTerminationIntent.js";

const logger = createLogger("main:ProcessDeath");

// An external sweep (a stray `pkill`) takes several children down within a
// few hundred ms. The window is anchored at the first death and never
// extended, so a steady stream of deaths still flushes on time.
export const PROCESS_DEATH_BURST_WINDOW_MS = 1_000;
const MAX_PENDING_DEATHS = 32;

export interface ProcessDeath {
  kind: "utility" | "renderer";
  /** Electron process type (`Utility`, `GPU`, ...) or the webContents type. */
  type: string;
  name: string;
  reason: string;
  exitCode: number;
  webContentsId?: number;
  /** Set when Daintree terminated the process itself. */
  intent?: string | null;
  at: number;
}

const summarize = (d: ProcessDeath) =>
  `${label(d)} ${describeProcessDeath(d.reason, d.exitCode, { intent: d.intent })}`;

function label(death: ProcessDeath): string {
  if (death.kind === "renderer") {
    return death.webContentsId !== undefined
      ? `renderer (${death.type} webContents ${death.webContentsId})`
      : `renderer (${death.type})`;
  }
  return death.name && death.name !== death.type ? `${death.name} (${death.type})` : death.type;
}

function toContext(death: ProcessDeath): Record<string, unknown> {
  return {
    kind: death.kind,
    type: death.type,
    name: death.name,
    reason: death.reason,
    exitCode: death.exitCode,
    ...(death.webContentsId !== undefined ? { webContentsId: death.webContentsId } : {}),
    ...(death.intent ? { initiatedBy: "daintree", intent: death.intent } : {}),
    at: new Date(death.at).toISOString(),
  };
}

export class ProcessDeathLogger {
  private pending: ProcessDeath[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `isShuttingDown` must only report a committed quit (a quit can be
   * cancelled). Deaths during teardown are expected, so they log at INFO.
   */
  constructor(
    private readonly isShuttingDown: () => boolean = () => false,
    private readonly now: () => number = Date.now
  ) {}

  record(death: Omit<ProcessDeath, "at"> & { at?: number }): void {
    this.pending.push({ ...death, at: death.at ?? this.now() });
    if (this.pending.length >= MAX_PENDING_DEATHS) {
      this.flush();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, PROCESS_DEATH_BURST_WINDOW_MS);
      this.flushTimer.unref?.();
    }
  }

  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const deaths = this.pending;
    if (deaths.length === 0) return;
    this.pending = [];

    // Teardown and Daintree's own kills are expected; only the rest is a fault.
    const shuttingDown = this.isShuttingDown();
    const expected = shuttingDown || deaths.every((d) => d.intent);
    const log = expected
      ? (message: string, context: Record<string, unknown>) => logger.info(message, context)
      : (message: string, context: Record<string, unknown>) => logger.warn(message, context);
    const shutdownContext = shuttingDown ? { duringShutdown: true } : {};

    if (deaths.length === 1) {
      const [death] = deaths;
      log(`Child process gone: ${summarize(death)}`, { ...toContext(death), ...shutdownContext });
      return;
    }

    const spanMs = deaths[deaths.length - 1].at - deaths[0].at;
    const externalKills = deaths.filter((d) => isExternalKill(d.reason, d.intent)).length;
    const cause =
      externalKills === deaths.length
        ? " — all terminated by a signal from outside the process"
        : externalKills > 0
          ? ` — ${externalKills} terminated by a signal from outside the process`
          : "";
    log(
      `${deaths.length} child processes gone within ${spanMs}ms${cause}: ${deaths.map(summarize).join("; ")}`,
      {
        count: deaths.length,
        spanMs,
        externalKills,
        firstAt: new Date(deaths[0].at).toISOString(),
        ...shutdownContext,
      }
    );
  }

  dispose(): void {
    this.flush();
  }
}

let instance: ProcessDeathLogger | null = null;
let removeListeners: (() => void) | null = null;

export function getProcessDeathLogger(): ProcessDeathLogger | null {
  return instance;
}

/**
 * Observe every child-process death Electron reports: utility processes
 * (Network Service, GPU, Daintree's hosts and workers) via
 * `child-process-gone`, and every renderer via `render-process-gone`.
 * Observation only — recovery stays with each process's owner.
 */
export function initializeProcessDeathLogger(): ProcessDeathLogger {
  if (instance) return instance;
  // Any claimed shutdown — including the handoff to app.exit/quitAndInstall.
  const deathLogger = new ProcessDeathLogger(() => getActiveShutdown() !== null);
  instance = deathLogger;

  const onChildGone = (_event: Electron.Event, details: Details) => {
    if (details.reason === "clean-exit") return;
    const name = details.name ?? details.serviceName ?? details.type;
    deathLogger.record({
      kind: "utility",
      type: details.type,
      name,
      reason: details.reason,
      exitCode: details.exitCode,
      intent: getTerminationIntent({ serviceName: name }),
    });
  };

  const onRendererGone = (
    _event: Electron.Event,
    webContents: WebContents,
    details: RenderProcessGoneDetails
  ) => {
    if (details.reason === "clean-exit") return;
    let type = "unknown";
    let webContentsId: number | undefined;
    try {
      type = webContents.getType();
      webContentsId = webContents.id;
    } catch {
      // Destroyed webContents — keep the death, drop the identity.
    }
    deathLogger.record({
      kind: "renderer",
      type,
      name: "renderer",
      reason: details.reason,
      exitCode: details.exitCode,
      webContentsId,
      intent: webContentsId !== undefined ? getTerminationIntent({ webContentsId }) : null,
    });
  };

  const onWillQuit = () => deathLogger.flush();

  app.on("child-process-gone", onChildGone);
  app.on("render-process-gone", onRendererGone);
  app.on("will-quit", onWillQuit);
  removeListeners = () => {
    app.off("child-process-gone", onChildGone);
    app.off("render-process-gone", onRendererGone);
    app.off("will-quit", onWillQuit);
  };

  return deathLogger;
}

export function resetProcessDeathLoggerForTesting(): void {
  removeListeners?.();
  removeListeners = null;
  instance?.dispose();
  instance = null;
}

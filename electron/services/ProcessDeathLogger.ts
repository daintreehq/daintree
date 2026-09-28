import { app, type Details, type RenderProcessGoneDetails, type WebContents } from "electron";
import { createLogger } from "../utils/logger.js";
import { isCleaningUp } from "../lifecycle/shutdownCoordinator.js";
import { describeProcessDeath, isSignalKill } from "./processDeathDescription.js";

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
  at: number;
}

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

    const shuttingDown = this.isShuttingDown();
    const log = shuttingDown
      ? (message: string, context: Record<string, unknown>) => logger.info(message, context)
      : (message: string, context: Record<string, unknown>) => logger.warn(message, context);
    const shutdownContext = shuttingDown ? { duringShutdown: true } : {};

    if (deaths.length === 1) {
      const [death] = deaths;
      log(
        `Child process gone: ${label(death)} ${describeProcessDeath(death.reason, death.exitCode)}`,
        { ...toContext(death), ...shutdownContext }
      );
      return;
    }

    const spanMs = deaths[deaths.length - 1].at - deaths[0].at;
    const signalKills = deaths.filter((d) => isSignalKill(d.reason)).length;
    const summary = deaths
      .map((d) => `${label(d)} ${describeProcessDeath(d.reason, d.exitCode)}`)
      .join("; ");
    const cause =
      signalKills === deaths.length
        ? " — all terminated by a signal from outside the process"
        : signalKills > 0
          ? ` — ${signalKills} terminated by a signal from outside the process`
          : "";
    log(`${deaths.length} child processes gone within ${spanMs}ms${cause}: ${summary}`, {
      count: deaths.length,
      spanMs,
      signalKills,
      firstAt: new Date(deaths[0].at).toISOString(),
      ...shutdownContext,
    });
  }

  dispose(): void {
    this.flush();
  }
}

let instance: ProcessDeathLogger | null = null;

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
  const deathLogger = new ProcessDeathLogger(isCleaningUp);
  instance = deathLogger;

  app.on("child-process-gone", (_event, details: Details) => {
    if (details.reason === "clean-exit") return;
    deathLogger.record({
      kind: "utility",
      type: details.type,
      name: details.name ?? details.serviceName ?? details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  app.on(
    "render-process-gone",
    (_event, webContents: WebContents, details: RenderProcessGoneDetails) => {
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
      });
    }
  );

  app.on("will-quit", () => deathLogger.flush());

  return deathLogger;
}

export function resetProcessDeathLoggerForTesting(): void {
  instance?.dispose();
  instance = null;
}

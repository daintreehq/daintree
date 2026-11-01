import type {
  DecisionsSettings,
  DecisionsState,
  DecisionsStatus,
  DecisionsStatusEvent,
} from "../../../shared/types/decisions.js";
import { decisionsLibraries, type DecisionsLibraries } from "./libraries.js";

export type DecisionsStatusListener = (event: DecisionsStatusEvent) => void;

/**
 * Decisions in main: one per process, made only once the setting is on. An
 * enabled lifetime runs from `start` to `stop`; the children that fill it in
 * (the store, keys, the relay socket) acquire their resources in `start` and
 * release them in `stop`, so turning Decisions off leaves nothing running.
 *
 * Transitions run one at a time, in the order asked, and a failed one doesn't
 * block the next. `dispose` is final: it wins over any start still queued.
 */
export class DecisionsService {
  readonly libraries: DecisionsLibraries = decisionsLibraries;

  private state: DecisionsState = "off";
  private settings: DecisionsSettings | null = null;
  private disposed = false;
  private transitions: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<DecisionsStatusListener>();

  getStatus(): DecisionsStatus {
    return { state: this.state };
  }

  /** The settings the running lifetime started with; null while stopped. */
  getSettings(): DecisionsSettings | null {
    return this.settings;
  }

  /** Called on every change of state, never for a repeat. Listeners outlive a stop, not a dispose. */
  onStatusChanged(listener: DecisionsStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Begins, or carries on, an enabled lifetime with these settings. Settings that are off start nothing. */
  start(settings: DecisionsSettings): Promise<void> {
    return this.enqueue(() => {
      if (this.disposed || !settings.enabled) return;
      this.settings = settings;
      // There is no relay identity until a relay is claimed or restored, and no
      // socket until one opens, so on is honestly "not connected" for now.
      if (this.state === "off") this.setState("not-connected");
    });
  }

  /** Ends the enabled lifetime. Another `start` may follow. */
  stop(): Promise<void> {
    return this.enqueue(() => this.release());
  }

  /** App shutdown: ends the lifetime for good, and no later start is honoured. */
  dispose(): Promise<void> {
    this.disposed = true;
    return this.enqueue(() => {
      this.release();
      this.listeners.clear();
    });
  }

  private release(): void {
    this.settings = null;
    this.setState("off");
  }

  private enqueue(step: () => void | Promise<void>): Promise<void> {
    const run = this.transitions.then(step);
    this.transitions = run.catch(() => {});
    return run;
  }

  private setState(next: DecisionsState): void {
    if (this.state === next) return;
    this.state = next;
    const event: DecisionsStatusEvent = { type: "status-changed", status: this.getStatus() };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.warn("[Decisions] A status listener threw:", err);
      }
    }
  }
}

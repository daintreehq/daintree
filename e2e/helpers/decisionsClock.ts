/**
 * One clock for a Decisions run end to end: each Daintree's main process, the
 * relay (started `clocked`) and each phone, moved past a deadline without
 * waiting for it, as the Decisions repository's own e2e suite moves its relay,
 * bridge and phone (its `e2e/tests/clock.ts`).
 *
 * Daintree is moved from outside, with no seam in the app: launched with
 * `launch()`, its main process loads decisionsClockPreload.cjs before any of
 * its own modules, so `Date.now` and `new Date()` there read the real time plus
 * an offset everywhere, the Decisions libraries included, and a relaunch picks
 * up where the clock is. Timers still run in real time, as across a real clock
 * jump. Three things stay on the real clock, and a spec reads around them:
 *
 * - The renderer: a spec reads badges once main has recorded how a question
 *   closed, not by the renderer's countdown.
 * - The PTY host, which stamps an agent's last state change: main reads that
 *   stamp as long settled, so the short settle grace before typing into a
 *   prompt that just appeared never holds. A working agent or a draft still
 *   holds a line, as neither is read by time.
 * - Waits main times by the wall clock (the 15-second admission of a line into
 *   a pane, a cached read of what the phone supports) end at a move. A spec
 *   moves time while nothing is on its way into a terminal, and asks again
 *   when an ask is refused `support-unknown` straight after a move.
 */

import path from "path";
import type { BrowserContext, ElectronApplication } from "@playwright/test";
import type { LocalRelay } from "./decisionsRelay";

const PRELOAD = path.join(import.meta.dirname, "decisionsClockPreload.cjs");

/**
 * The longest single step of a move. The relay refuses a signed request more
 * than two minutes from its clock (`LIMITS.requestSkewMs`), and the clocks move
 * one after another, so each step keeps every participant well inside that.
 */
const STEP_MS = 60_000;

async function setMainOffset(app: ElectronApplication, offsetMs: number): Promise<void> {
  const installed = await app.evaluate((_electron, offset) => {
    const clock = (globalThis as unknown as { __daintreeE2eClock?: { offsetMs: number } })
      .__daintreeE2eClock;
    if (!clock) return false;
    clock.offsetMs = offset;
    return true;
  }, offsetMs);
  if (!installed) throw new Error("This app has no moved clock: launch it with clock.launch()");
}

/** How far an app's main process reads ahead of the real clock, by `Date.now` and by `new Date()`. */
export async function mainClockOffsets(
  app: ElectronApplication
): Promise<{ now: number; date: number }> {
  const before = Date.now();
  const [now, date] = await app.evaluate(() => [Date.now(), new Date().getTime()]);
  const real = (before + Date.now()) / 2;
  return { now: now - real, date: date - real };
}

export class DecisionsTestClock {
  private offsetMs = 0;
  private readonly apps = new Set<ElectronApplication>();
  private readonly phones: BrowserContext[] = [];
  private queue: Promise<void> = Promise.resolve();
  /** Why a move stopped partway: the clocks then disagree, and every later move is refused. */
  private broken: Error | null = null;

  constructor(private readonly relay: LocalRelay) {}

  /** The system's time, in ms since the epoch. */
  readonly now = (): number => Date.now() + this.offsetMs;

  /** How far the clock has been moved past the real one, in ms. */
  get offset(): number {
    return this.offsetMs;
  }

  /**
   * What a Daintree launches with to be on this clock from its first line of
   * code, at the offset the clock has reached: `launchApp({ ...clock.launch(env) })`.
   * The preload goes in as a `-r` argument, beside Playwright's own loader,
   * since Playwright drops `NODE_OPTIONS` from an Electron launch.
   */
  launch(env: Record<string, string> = {}): { env: Record<string, string>; extraArgs: string[] } {
    return {
      env: { ...env, DAINTREE_E2E_CLOCK_OFFSET_MS: String(this.offsetMs) },
      extraArgs: ["-r", PRELOAD],
    };
  }

  /** Moves an app launched with `launch()` with this clock from now on. */
  attachApp(app: ElectronApplication): Promise<void> {
    return this.serially(async () => {
      await setMainOffset(app, this.offsetMs);
      this.apps.add(app);
    });
  }

  /** Stops moving an app before it quits. */
  detachApp(app: ElectronApplication): void {
    this.apps.delete(app);
  }

  /** Puts a phone on this clock. Call it before the context's first page loads. */
  attachPhone(context: BrowserContext): Promise<void> {
    return this.serially(async () => {
      await context.clock.install({ time: this.now() });
      this.phones.push(context);
    });
  }

  /**
   * Moves every clock forward by `ms`, in steps of at most a minute. Each step
   * moves Daintree first, then the relay (which runs whatever came due), then
   * the phones, so Daintree is never behind the relay when an expiry reaches
   * it (one received well before its deadline by the receiver's clock is
   * refused for good) and no signed request leaves the relay's skew allowance.
   */
  advance(ms: number): Promise<void> {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error(`cannot advance the clock by ${ms}`);
    return this.serially(async () => {
      try {
        for (let left = ms; left > 0;) {
          const step = Math.min(left, STEP_MS);
          this.offsetMs += step;
          for (const app of this.apps) await setMainOffset(app, this.offsetMs);
          await this.relay.setClock(this.offsetMs);
          for (const phone of this.phones) await phone.clock.fastForward(step);
          left -= step;
        }
      } catch (error) {
        this.broken = error as Error;
        throw error;
      }
    });
  }

  /**
   * Moves every clock to `byMs` past `deadline` (ISO 8601). The deadline is
   * crossed by the last step, which is at most a minute, and the clocks then
   * hold: a notice queued for a pane has a 15-second admission that a further
   * jump would use up before it could be typed.
   */
  async advancePast(deadline: string, byMs = 30_000): Promise<void> {
    // Stopping short leaves room for the real time the approach itself takes.
    const margin = 20_000;
    if (byMs <= 0 || byMs + margin > STEP_MS) throw new Error(`cannot cross a deadline by ${byMs}`);
    await this.advance(Math.max(0, Math.ceil(Date.parse(deadline) - this.now()) - margin));
    await this.advance(Math.max(0, Math.ceil(Date.parse(deadline) - this.now())) + byMs);
  }

  private serially(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(() => {
      if (this.broken) {
        throw new Error(`An earlier move left the clocks apart: ${this.broken.message}`);
      }
      return task();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

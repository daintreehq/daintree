/**
 * Classifies a stream of wheel events as coming from a physical mouse wheel
 * (discrete detents) versus a trackpad / Magic Mouse (continuous, high-rate
 * motion). Ported from VS Code's `MouseWheelClassifier`
 * (`src/vs/base/browser/ui/scrollbar/scrollableElement.ts`) — the same algorithm
 * xterm bundles privately for its own viewport smooth-scroll gating.
 *
 * Daintree uses it for ONE thing: choosing the per-frame send-rate cap for
 * synthetic mouse-wheel reports in a mouse-reporting TUI. Trackpad momentum is
 * the gesture that floods the PTY round-trip (dozens of events/sec), so it gets
 * a gentler cap than a physical wheel's discrete detents. None of VS Code's
 * other uses (smooth scroll, inertial scroll, ctrl-zoom) apply to our synthetic
 * report path — the verdict is only an input to pacing.
 *
 * Per-terminal instance (NOT a singleton like VS Code's): two panes can be
 * scrolled by different devices at the same time.
 *
 * Algorithm: a 5-event circular buffer; each event is scored 0 (mouse) → 1
 * (trackpad) by `_computeScore`, and `isPhysicalMouseWheel()` returns whether an
 * exponentially-weighted average of the buffered scores sits at or below 0.5.
 */
class MouseWheelClassifierItem {
  public score = 0;
  constructor(
    public readonly timestamp: number,
    public readonly deltaX: number,
    public readonly deltaY: number
  ) {}
}

export class MouseWheelClassifier {
  private readonly _capacity = 5;
  private _memory: MouseWheelClassifierItem[] = [];
  private _front = -1;
  private _rear = -1;

  /**
   * Forget all buffered events — call at a gesture boundary (e.g. after an idle
   * gap) so the previous gesture's device history doesn't bias the next verdict.
   */
  public reset(): void {
    this._memory = [];
    this._front = -1;
    this._rear = -1;
  }

  /** Feed one physical wheel event. `timestamp` is stored for parity but unused by the verdict. */
  public accept(timestamp: number, deltaX: number, deltaY: number): void {
    let previousItem: MouseWheelClassifierItem | null = null;
    const item = new MouseWheelClassifierItem(timestamp, deltaX, deltaY);

    if (this._front === -1 && this._rear === -1) {
      this._memory[0] = item;
      this._front = 0;
      this._rear = 0;
    } else {
      previousItem = this._memory[this._rear] ?? null;
      this._rear = (this._rear + 1) % this._capacity;
      if (this._rear === this._front) {
        this._front = (this._front + 1) % this._capacity;
      }
      this._memory[this._rear] = item;
    }

    item.score = this._computeScore(item, previousItem);
  }

  /**
   * Score one event: physical wheels move on a single axis with integer deltas
   * that repeat by a consistent factor (the OS acceleration step); trackpads
   * emit fractional, often dual-axis deltas. 0 = mouse, 1 = trackpad.
   */
  private _computeScore(
    item: MouseWheelClassifierItem,
    previousItem: MouseWheelClassifierItem | null
  ): number {
    // Both axes moving at once is a trackpad/Magic-Mouse signature — a physical
    // wheel reports a single axis.
    if (Math.abs(item.deltaX) > 0 && Math.abs(item.deltaY) > 0) {
      return 1;
    }

    let score = 0.5;

    // Fractional deltas come from continuous (trackpad) motion.
    if (!this._isAlmostInt(item.deltaX) || !this._isAlmostInt(item.deltaY)) {
      score += 0.25;
    }

    if (previousItem) {
      const absDeltaX = Math.abs(item.deltaX);
      const absDeltaY = Math.abs(item.deltaY);
      const absPreviousDeltaX = Math.abs(previousItem.deltaX);
      const absPreviousDeltaY = Math.abs(previousItem.deltaY);

      const minDeltaX = Math.max(Math.min(absDeltaX, absPreviousDeltaX), 1);
      const minDeltaY = Math.max(Math.min(absDeltaY, absPreviousDeltaY), 1);
      const maxDeltaX = Math.max(absDeltaX, absPreviousDeltaX);
      const maxDeltaY = Math.max(absDeltaY, absPreviousDeltaY);

      // A consistent multiplicative relationship between consecutive deltas is
      // the OS wheel-acceleration fingerprint of a physical wheel.
      const isSameModulo = maxDeltaX % minDeltaX === 0 && maxDeltaY % minDeltaY === 0;
      if (isSameModulo) {
        score -= 0.5;
      }
    }

    return Math.min(Math.max(score, 0), 1);
  }

  private _isAlmostInt(value: number): boolean {
    const delta = Math.abs(Math.round(value) - value);
    return delta < 0.01;
  }

  /**
   * Verdict: an exponentially-weighted average of the buffered scores (most
   * recent event weighted 0.5, then 0.25, 0.125, …). At or below 0.5 → physical
   * wheel. An empty buffer reports `false` (treated as trackpad) so the gentler
   * cap applies until we have evidence of a discrete wheel.
   */
  public isPhysicalMouseWheel(): boolean {
    if (this._front === -1 && this._rear === -1) {
      return false;
    }

    let remainingInfluence = 1;
    let score = 0;
    let iteration = 1;
    let index = this._rear;
    let done = false;

    while (!done) {
      const influence = index === this._front ? remainingInfluence : Math.pow(2, -iteration);
      remainingInfluence -= influence;
      score += (this._memory[index]?.score ?? 0) * influence;

      if (index === this._front) {
        done = true;
      } else {
        index = (this._capacity + index - 1) % this._capacity;
        iteration++;
      }
    }

    return score <= 0.5;
  }
}

import { useEffect, useRef } from "react";
import { isMac } from "@/lib/platform";
import { runSpringLoop } from "@/lib/demoSpring";
import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { usePanelStore } from "@/store/panelStore";
import type {
  DemoMoveToPayload,
  DemoMoveToSelectorPayload,
  DemoTypePayload,
  DemoWaitForSelectorPayload,
  DemoSleepPayload,
  DemoScrollPayload,
  DemoDragPayload,
  DemoPressKeyPayload,
  DemoWaitForIdlePayload,
  DemoTypeInTerminalPayload,
  DemoSendKeyToTerminalPayload,
} from "@shared/types/ipc/demo";

const CURSOR_SVG_PATH = "M2.5 1L17.5 13.5H9.5L14 22L11 23.5L6.5 15L2.5 19.5V1Z";

const FITTS_A = 100;
const FITTS_B = 200;
const FITTS_DEFAULT_W = 40;
const TWO_PHASE_THRESHOLD = 300;

// Short moves accelerate from rest with a bell-shaped velocity profile (ease-in-out),
// matching the ballistic ease-in start the long-move path already uses.
const SHORT_MOVE_EASING = "cubic-bezier(0.25, 0, 0.65, 1)";

// Occasional subtle overshoot-and-correct on larger moves (Fitts's Law naturalism).
// Probability scales with distance; magnitude stays small so the cursor never drifts
// far enough to hover the wrong target. Purely cosmetic — left/top are committed to the
// real target before the overshoot runs, so posRef stays accurate for click dispatch.
const OVERSHOOT_FAR_THRESHOLD = 600;
const OVERSHOOT_PROB_MID = 0.15;
const OVERSHOOT_PROB_FAR = 0.2;
const OVERSHOOT_DURATION_MS = 180;
const OVERSHOOT_DISTANCE_FRACTION = 0.1;
const OVERSHOOT_MAG_CAP = 20;
const OVERSHOOT_PERP_FRACTION = 0.2;
const OVERSHOOT_PEAK_OFFSET = 0.88;

function getDemoApi() {
  return window.electron.demo!;
}

function noise1D(x: number): number {
  const h = (n: number) => Math.abs(Math.sin(n) * 1e4) % 1;
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  return h(i) * (1 - s) + h(i + 1) * s;
}

function gaussianRandom(mean: number, stdev: number): number {
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return Math.max(20, z * stdev + mean);
}

function fittsDuration(dist: number, targetWidth?: number): number {
  const w = targetWidth ?? FITTS_DEFAULT_W;
  const t = FITTS_A + FITTS_B * Math.log2(1 + dist / w);
  return Math.min(3000, Math.max(200, t));
}

function movementSteps(dist: number): number {
  return Math.round(Math.min(60, Math.max(10, dist / 20)));
}

function getTypingDelay(char: string, prevChar: string, baseMean: number): number {
  if (Math.random() < 0.01) return gaussianRandom(1200, 400);
  let mean = baseMean;
  let stdev = baseMean * 0.18;
  if (/[.!?,;:]/.test(prevChar)) {
    mean = baseMean * 3.5;
    stdev = baseMean * 1.2;
  } else if (prevChar === " ") {
    mean = baseMean * 2.2;
    stdev = baseMean * 0.6;
  } else if (/[a-zA-Z]/.test(char) && /[a-zA-Z]/.test(prevChar)) {
    mean = baseMean * 0.7;
    stdev = baseMean * 0.12;
  }
  return gaussianRandom(mean, stdev);
}

// Escape sequences for special keys sent into a terminal. Arrow keys have a
// separate application-cursor-mode (DECCKM) form used by TUIs (vim, less); the
// renderer reads the live xterm mode to pick the right one. All other keys are
// mode-independent.
const TERMINAL_KEY_NORMAL: Record<string, string> = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  backspace: "\x7f",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  "ctrl-u": "\x15",
};

const TERMINAL_KEY_APP: Record<string, string> = {
  up: "\x1bOA",
  down: "\x1bOB",
  right: "\x1bOC",
  left: "\x1bOD",
};

function resolveTerminalKey(key: string, appCursorMode: boolean): string | null {
  if (appCursorMode && key in TERMINAL_KEY_APP) {
    return TERMINAL_KEY_APP[key]!;
  }
  return TERMINAL_KEY_NORMAL[key] ?? null;
}

// Resolve a terminal panel id from a selector that either targets the panel
// root (`[data-panel-id="x"]`) or any element inside it.
function getPanelIdFromSelector(selector: string): string | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const panel = el.closest("[data-panel-id]");
  return panel?.getAttribute("data-panel-id") ?? null;
}

function cubicBezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

export function computeBezierKeyframes(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  steps: number,
  seed: number
): Array<{ transform: string }> {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  const perpX = dist > 0 ? -dy / dist : 0;
  const perpY = dist > 0 ? dx / dist : 0;

  // Which way the arc bows. Drawn first so the call order stays stable.
  const sign = Math.random() > 0.5 ? 1 : -1;

  // Sqrt taper: the leading control point's deviation grows sub-linearly with
  // distance, so short nudges stay nearly straight while long sweeps bow
  // noticeably, capped so very long moves don't balloon.
  const p1Dist = Math.min(Math.sqrt(dist) * (1.5 + Math.random() * 1.5), 80);

  // Occasional mid-flight correction: only long moves can inflect into an S, and
  // only some of the time.
  const isSCurve = dist > TWO_PHASE_THRESHOLD && Math.random() < 0.2;

  let p1t: number;
  let p2t: number;
  let p2Dist: number;
  let p2Sign: number;
  if (isSCurve) {
    // S-shaped path: a comparable second lobe to the opposite side, placed
    // mid-flight so the inflection is actually visible rather than a sub-pixel
    // wobble at the very end.
    p1t = 0.2 + Math.random() * 0.1;
    p2t = 0.6 + Math.random() * 0.1;
    p2Dist = p1Dist * (0.5 + Math.random() * 0.3);
    p2Sign = -sign;
  } else {
    // Single bow: peak early during acceleration, then settle the trailing
    // control point most of the way back to the chord so the path decelerates
    // straight into the target.
    p1t = 0.25 + Math.random() * 0.15;
    p2t = 0.9 + Math.random() * 0.05;
    p2Dist = p1Dist * (0.1 + Math.random() * 0.15);
    p2Sign = sign;
  }

  const p1x = fromX + dx * p1t + perpX * p1Dist * sign;
  const p1y = fromY + dy * p1t + perpY * p1Dist * sign;

  const p2x = fromX + dx * p2t + perpX * p2Dist * p2Sign;
  const p2y = fromY + dy * p2t + perpY * p2Dist * p2Sign;

  const jitterAmplitude = Math.min(2, dist * 0.003);
  const safeSteps = Math.max(1, steps);
  const frames: Array<{ transform: string }> = [];
  for (let i = 0; i <= safeSteps; i++) {
    const t = i / safeSteps;
    let x = cubicBezier(t, fromX, p1x, p2x, toX) - fromX;
    let y = cubicBezier(t, fromY, p1y, p2y, toY) - fromY;

    if (i > 0 && i < safeSteps && jitterAmplitude > 0) {
      const noiseVal = (noise1D(i * 0.15 + seed) * 2 - 1) * jitterAmplitude;
      x += perpX * noiseVal;
      y += perpY * noiseVal;
    }

    frames.push({ transform: `translate(${x}px, ${y}px)` });
  }
  return frames;
}

function shouldOvershoot(dist: number): boolean {
  if (dist <= TWO_PHASE_THRESHOLD) return false;
  const prob = dist >= OVERSHOOT_FAR_THRESHOLD ? OVERSHOOT_PROB_FAR : OVERSHOOT_PROB_MID;
  return Math.random() < prob;
}

function computeOvershootKeyframes(
  dx: number,
  dy: number,
  dist: number
): Array<{ transform: string; offset: number }> {
  const dirX = dist > 0 ? dx / dist : 0;
  const dirY = dist > 0 ? dy / dist : 0;
  const perpX = -dirY;
  const perpY = dirX;

  const magnitude = Math.min(dist * OVERSHOOT_DISTANCE_FRACTION, OVERSHOOT_MAG_CAP);
  const perpMag = magnitude * OVERSHOOT_PERP_FRACTION * (Math.random() > 0.5 ? 1 : -1);

  const peakX = dirX * magnitude + perpX * perpMag;
  const peakY = dirY * magnitude + perpY * perpMag;

  return [
    { transform: "translate(0px, 0px)", offset: 0 },
    { transform: `translate(${peakX}px, ${peakY}px)`, offset: OVERSHOOT_PEAK_OFFSET },
    { transform: "translate(0px, 0px)", offset: 1 },
  ];
}

// Absolute {x, y} sample of the same arced path used by computeBezierKeyframes,
// evaluated at a single parameter t. Control points are derived deterministically
// from `seed` (not Math.random) so repeated per-frame samples trace one stable arc.
// Used by the drag handler to drive the visible glyph and synthetic move events
// from identical coordinates each animation frame.
function computeBezierPoint(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  seed: number,
  t: number
): { x: number; y: number } {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  const perpX = dist > 0 ? -dy / dist : 0;
  const perpY = dist > 0 ? dx / dist : 0;

  const offset = dist * (0.05 + noise1D(seed) * 0.25);
  const sign = noise1D(seed + 100) > 0.5 ? 1 : -1;

  const p1x = fromX + dx * 0.33 + perpX * offset * sign;
  const p1y = fromY + dy * 0.33 + perpY * offset * sign;
  const p2x = fromX + dx * 0.8 + perpX * offset * 0.3 * sign + dx * 0.05;
  const p2y = fromY + dy * 0.8 + perpY * offset * 0.3 * sign + dy * 0.05;

  // Ease-out on the timeline so the drag decelerates onto the target,
  // matching the perceived feel of animateCursor's WAAPI easing.
  const easedT = 1 - Math.pow(1 - t, 3);
  let x = cubicBezier(easedT, fromX, p1x, p2x, toX);
  let y = cubicBezier(easedT, fromY, p1y, p2y, toY);

  const jitterAmplitude = Math.min(2, dist * 0.003);
  if (t > 0 && t < 1 && jitterAmplitude > 0) {
    const noiseVal = (noise1D(t * 10 + seed) * 2 - 1) * jitterAmplitude;
    x += perpX * noiseVal;
    y += perpY * noiseVal;
  }

  return { x, y };
}

export function DemoCursor() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const svgWrapperRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLDivElement>(null);
  const posRef = useRef({ x: 0, y: 0 });
  const pauseResolversRef = useRef<Array<() => void>>([]);
  const pausedRef = useRef(false);
  const scrollAnimRef = useRef<{ cancel: () => void } | null>(null);

  useEffect(() => {
    posRef.current = {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    };

    const el = cursorRef.current;
    if (el) {
      el.style.left = `${posRef.current.x}px`;
      el.style.top = `${posRef.current.y}px`;
    }
  }, []);

  useEffect(() => {
    const demo = getDemoApi();
    const cleanups: Array<() => void> = [];

    function sendDone(requestId: string, error?: string) {
      demo.sendCommandDone(requestId, error);
    }

    async function waitIfPaused(): Promise<void> {
      if (!pausedRef.current) return;
      return new Promise<void>((resolve) => {
        pauseResolversRef.current.push(resolve);
      });
    }

    async function pauseAwareDelay(ms: number): Promise<void> {
      let remaining = ms;
      while (remaining > 0) {
        await waitIfPaused();
        const chunk = Math.min(remaining, 50);
        await new Promise<void>((resolve) => setTimeout(resolve, chunk));
        remaining -= chunk;
      }
    }

    async function animateCursor(
      targetX: number,
      targetY: number,
      durationMs?: number,
      targetWidth?: number
    ): Promise<void> {
      const el = cursorRef.current;
      if (!el) return;

      const fromX = posRef.current.x;
      const fromY = posRef.current.y;
      const dx = targetX - fromX;
      const dy = targetY - fromY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      const totalDuration = durationMs ?? fittsDuration(dist, targetWidth);
      const steps = movementSteps(dist);
      const seed = Math.random() * 1000;

      if (dist > TWO_PHASE_THRESHOLD) {
        const splitIndex = Math.round(steps * 0.8);
        const allKeyframes = computeBezierKeyframes(fromX, fromY, targetX, targetY, steps, seed);

        const ballisticKeyframes = allKeyframes.slice(0, splitIndex + 1);
        const ballisticDuration = totalDuration * 0.75;
        const ballisticAnim = el.animate(ballisticKeyframes, {
          duration: ballisticDuration,
          easing: "cubic-bezier(0.32, 0, 0.67, 0)",
          fill: "forwards",
        });
        await ballisticAnim.finished;

        const lastBallistic = allKeyframes[splitIndex]!.transform;
        const match = lastBallistic.match(/translate\(([^p]+)px,\s*([^p]+)px\)/);
        const midX = fromX + (match ? parseFloat(match[1]!) : dx * 0.8);
        const midY = fromY + (match ? parseFloat(match[2]!) : dy * 0.8);
        el.style.left = `${midX}px`;
        el.style.top = `${midY}px`;
        el.style.transform = "";
        ballisticAnim.cancel();

        const acquisitionKeyframes = allKeyframes.slice(splitIndex).map((kf, i) => {
          if (i === 0) return { transform: "translate(0px, 0px)" };
          const m = kf.transform.match(/translate\(([^p]+)px,\s*([^p]+)px\)/);
          if (!m) return kf;
          const origX = parseFloat(m[1]!) + fromX;
          const origY = parseFloat(m[2]!) + fromY;
          return { transform: `translate(${origX - midX}px, ${origY - midY}px)` };
        });

        const acquisitionDuration = totalDuration * 0.25;
        const acquisitionAnim = el.animate(acquisitionKeyframes, {
          duration: acquisitionDuration,
          easing: "cubic-bezier(0.33, 1, 0.68, 1)",
          fill: "forwards",
        });
        await acquisitionAnim.finished;
        el.style.left = `${targetX}px`;
        el.style.top = `${targetY}px`;
        el.style.transform = "";
        acquisitionAnim.cancel();

        // Real target is committed; posRef is accurate before any cosmetic overshoot so a
        // click dispatched after this resolves reads the true landing position.
        posRef.current = { x: targetX, y: targetY };

        if (shouldOvershoot(dist)) {
          // The overshoot is purely cosmetic — the logical move already landed on the real
          // target above. If the animation is aborted mid-flight, swallow it so a cosmetic
          // failure never poisons the command result.
          const overshootAnim = el.animate(computeOvershootKeyframes(dx, dy, dist), {
            duration: OVERSHOOT_DURATION_MS,
            easing: "ease-in-out",
            fill: "forwards",
          });
          try {
            await overshootAnim.finished;
          } catch {
            // animation cancelled — position is already committed, nothing to recover
          }
          el.style.transform = "";
          overshootAnim.cancel();
        }
        return;
      }

      const keyframes = computeBezierKeyframes(fromX, fromY, targetX, targetY, steps, seed);
      const anim = el.animate(keyframes, {
        duration: totalDuration,
        easing: SHORT_MOVE_EASING,
        fill: "forwards",
      });
      await anim.finished;
      el.style.left = `${targetX}px`;
      el.style.top = `${targetY}px`;
      el.style.transform = "";
      anim.cancel();

      posRef.current = { x: targetX, y: targetY };
    }

    cleanups.push(
      demo.onExecCommand("demo:exec-move-to", async (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as DemoMoveToPayload & { requestId: string };
        try {
          await waitIfPaused();
          const targetX = (payload.x / 100) * window.innerWidth;
          const targetY = (payload.y / 100) * window.innerHeight;
          await animateCursor(targetX, targetY, payload.durationMs);
          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-move-to-selector", async (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as DemoMoveToSelectorPayload & { requestId: string };
        try {
          await waitIfPaused();

          const elements = document.querySelectorAll(payload.selector);
          let target: Element | null = null;
          for (const el of elements) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            const htmlEl = el as HTMLElement;
            if (htmlEl.checkVisibility ? htmlEl.checkVisibility() : htmlEl.offsetParent !== null) {
              target = el;
              break;
            }
          }

          if (!target) {
            sendDone(payload.requestId, `Selector not found or not visible: ${payload.selector}`);
            return;
          }

          target.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
          const rect = target.getBoundingClientRect();
          const targetX = rect.left + rect.width / 2 + (payload.offsetX ?? 0);
          const targetY = rect.top + rect.height / 2 + (payload.offsetY ?? 0);

          await animateCursor(
            targetX,
            targetY,
            payload.durationMs,
            Math.min(rect.width, rect.height)
          );
          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-click", async (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as { requestId: string };
        try {
          await waitIfPaused();
          const wrapper = svgWrapperRef.current;
          const ripple = rippleRef.current;
          if (!wrapper) {
            sendDone(payload.requestId);
            return;
          }

          const pressAnim = wrapper.animate(
            [{ transform: "scale(1)" }, { transform: "scale(0.85)" }],
            { duration: 80, easing: "ease-in", fill: "forwards" }
          );
          await pressAnim.finished;
          pressAnim.cancel();
          wrapper.style.transform = "scale(0.85)";

          const releaseAnim = wrapper.animate(
            [{ transform: "scale(0.85)" }, { transform: "scale(1)" }],
            { duration: 120, easing: "ease-out", fill: "forwards" }
          );

          if (ripple) {
            const rippleAnim = ripple.animate(
              [
                { transform: "scale(0.5)", opacity: "0.3" },
                { transform: "scale(2.5)", opacity: "0" },
              ],
              { duration: 400, easing: "ease-out", fill: "forwards" }
            );
            rippleAnim.finished.then(() => rippleAnim.cancel());
          }

          await releaseAnim.finished;
          releaseAnim.cancel();
          wrapper.style.transform = "scale(1)";

          const cursor = cursorRef.current;
          if (cursor) {
            const settleX = (Math.random() * 2 - 1) * 1.5;
            const settleY = (Math.random() * 2 - 1) * 1.5;
            const settleAnim = cursor.animate(
              [
                { transform: "translate(0px, 0px)" },
                { transform: `translate(${settleX}px, ${settleY}px)` },
              ],
              { duration: 150, easing: "ease-out", fill: "forwards" }
            );
            await settleAnim.finished;
            posRef.current.x += settleX;
            posRef.current.y += settleY;
            cursor.style.left = `${posRef.current.x}px`;
            cursor.style.top = `${posRef.current.y}px`;
            cursor.style.transform = "";
            settleAnim.cancel();
          }

          const { x: cx, y: cy } = posRef.current;
          const clickTarget = document.elementFromPoint(cx, cy);
          if (clickTarget) {
            const opts = {
              bubbles: true,
              cancelable: true,
              clientX: cx,
              clientY: cy,
            };
            // Lead each MouseEvent with its PointerEvent counterpart: Radix triggers
            // open on onPointerDown and dnd-kit's PointerSensor activates on pointerdown,
            // so a mouse-only dispatch silently no-ops on pointer-first controls (#10145).
            const pointerOpts = {
              ...opts,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true,
              button: 0,
            };
            clickTarget.dispatchEvent(new PointerEvent("pointerdown", { ...pointerOpts, buttons: 1 }));
            clickTarget.dispatchEvent(new MouseEvent("mousedown", { ...opts, buttons: 1 }));
            clickTarget.dispatchEvent(new PointerEvent("pointerup", { ...pointerOpts, buttons: 0 }));
            clickTarget.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
            clickTarget.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
          }

          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-type", async (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as DemoTypePayload & { requestId: string };
        try {
          await waitIfPaused();
          const target = document.querySelector(payload.selector) as HTMLElement | null;
          if (!target) {
            sendDone(payload.requestId, `Selector not found: ${payload.selector}`);
            return;
          }

          const cps = Math.max(1, payload.cps ?? 12);
          const baseMean = 1000 / cps;

          const cmView = EditorView.findFromDOM(target);
          if (cmView) {
            cmView.focus();
            let prevChar = "";
            for (const char of payload.text) {
              await waitIfPaused();
              const pos = cmView.state.selection.main.head;
              cmView.dispatch({
                changes: { from: pos, insert: char },
                selection: { anchor: pos + char.length },
                annotations: Transaction.userEvent.of("input"),
              });
              await pauseAwareDelay(getTypingDelay(char, prevChar, baseMean));
              prevChar = char;
            }
          } else {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            const inputTarget = target as HTMLInputElement | HTMLTextAreaElement;
            inputTarget.focus();
            let prevChar = "";
            for (const char of payload.text) {
              await waitIfPaused();
              inputTarget.value += char;
              inputTarget.dispatchEvent(
                new InputEvent("input", { inputType: "insertText", data: char, bubbles: true })
              );
              await pauseAwareDelay(getTypingDelay(char, prevChar, baseMean));
              prevChar = char;
            }
          }
          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    // --- type-in-terminal: humanized char-by-char PTY write into a terminal ---
    cleanups.push(
      demo.onExecCommand("demo:exec-type-in-terminal", async (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as DemoTypeInTerminalPayload & { requestId: string };
        try {
          await waitIfPaused();
          const panelId = getPanelIdFromSelector(payload.selector);
          if (!panelId) {
            sendDone(payload.requestId, `Terminal panel not found: ${payload.selector}`);
            return;
          }

          const cps = Math.max(1, payload.cps ?? 12);
          const baseMean = 1000 / cps;
          let prevChar = "";
          for (const char of payload.text) {
            await waitIfPaused();
            window.electron.terminal.write(panelId, char);
            await pauseAwareDelay(getTypingDelay(char, prevChar, baseMean));
            prevChar = char;
          }
          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    // --- send-key-to-terminal: write a special-key escape sequence to the PTY ---
    cleanups.push(
      demo.onExecCommand("demo:exec-send-key-to-terminal", async (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as DemoSendKeyToTerminalPayload & { requestId: string };
        try {
          await waitIfPaused();
          const panelId = getPanelIdFromSelector(payload.selector);
          if (!panelId) {
            sendDone(payload.requestId, `Terminal panel not found: ${payload.selector}`);
            return;
          }

          const appCursorMode =
            terminalInstanceService.get(panelId)?.terminal.modes.applicationCursorKeysMode ?? false;
          const seq = resolveTerminalKey(payload.key, appCursorMode);
          if (seq === null) {
            sendDone(payload.requestId, `Unknown terminal key: ${payload.key}`);
            return;
          }

          window.electron.terminal.write(panelId, seq);
          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-wait-for-selector", async (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as DemoWaitForSelectorPayload & { requestId: string };
        try {
          if (document.querySelector(payload.selector)) {
            sendDone(payload.requestId);
            return;
          }

          const timeoutMs = payload.timeoutMs ?? 10_000;
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              observer.disconnect();
              reject(new Error(`waitForSelector timed out: ${payload.selector}`));
            }, timeoutMs);

            const observer = new MutationObserver(() => {
              if (document.querySelector(payload.selector)) {
                clearTimeout(timeout);
                observer.disconnect();
                resolve();
              }
            });
            observer.observe(document.body, { subtree: true, childList: true });
          });
          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-sleep", async (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as DemoSleepPayload & { requestId: string };
        try {
          await pauseAwareDelay(payload.durationMs);
          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    // --- scroll handler: spring-animate scrollTop on nearest scrollable ancestor ---
    cleanups.push(
      demo.onExecCommand("demo:exec-scroll", async (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as DemoScrollPayload & { requestId: string };
        try {
          await waitIfPaused();
          const target = document.querySelector(payload.selector) as HTMLElement | null;
          if (!target) {
            sendDone(payload.requestId, `Selector not found: ${payload.selector}`);
            return;
          }

          // Find nearest scrollable ancestor
          let container: HTMLElement | null = target.parentElement;
          while (container) {
            const style = getComputedStyle(container);
            const overflowY = style.overflowY;
            if (
              (overflowY === "auto" || overflowY === "scroll") &&
              container.scrollHeight > container.clientHeight
            ) {
              break;
            }
            container = container.parentElement;
          }
          if (!container) {
            sendDone(payload.requestId, `No scrollable ancestor found for: ${payload.selector}`);
            return;
          }

          // Calculate target scrollTop to bring element into view (centered)
          const containerRect = container.getBoundingClientRect();
          const targetRect = target.getBoundingClientRect();
          const targetScrollTop =
            container.scrollTop +
            (targetRect.top - containerRect.top) -
            containerRect.height / 2 +
            targetRect.height / 2;
          const clampedTarget = Math.max(
            0,
            Math.min(targetScrollTop, container.scrollHeight - container.clientHeight)
          );

          // Frame-rate-independent spring glide (see src/lib/demoSpring.ts).
          await new Promise<void>((resolve) => {
            scrollAnimRef.current = runSpringLoop(
              { scroll: { current: container!.scrollTop, velocity: 0 } },
              { scroll: clampedTarget },
              (axes) => {
                container!.scrollTop = axes.scroll.current;
              },
              () => {
                container!.scrollTop = clampedTarget;
                scrollAnimRef.current = null;
                resolve();
              }
            );
          });

          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    // --- drag handler: mousedown → animate → mousemove×N → mouseup ---
    cleanups.push(
      demo.onExecCommand("demo:exec-drag", async (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as DemoDragPayload & { requestId: string };
        try {
          await waitIfPaused();
          const fromEl = document.querySelector(payload.fromSelector) as HTMLElement | null;
          const toEl = document.querySelector(payload.toSelector) as HTMLElement | null;
          if (!fromEl) {
            sendDone(payload.requestId, `Source not found: ${payload.fromSelector}`);
            return;
          }
          if (!toEl) {
            sendDone(payload.requestId, `Target not found: ${payload.toSelector}`);
            return;
          }

          const fromRect = fromEl.getBoundingClientRect();
          const toRect = toEl.getBoundingClientRect();
          const fromX = fromRect.left + fromRect.width / 2;
          const fromY = fromRect.top + fromRect.height / 2;
          const toX = toRect.left + toRect.width / 2;
          const toY = toRect.top + toRect.height / 2;

          const eventOpts = { bubbles: true, cancelable: true };
          // dnd-kit's PointerSensor hard-gates activation on isPrimary && button === 0,
          // and Radix Select reads pointerType/pointerId; without these a synthetic drag
          // never starts a pointer-first sortable (#10145). `button` is set per-event
          // (0 on down/up, -1 on move per the Pointer Events spec).
          const pointerMeta = { pointerId: 1, pointerType: "mouse", isPrimary: true };

          // Move cursor to source first
          await animateCursor(fromX, fromY, Math.min(payload.durationMs ?? 500, 300));

          // Press down at source
          const sourceTarget = document.elementFromPoint(fromX, fromY) ?? fromEl;
          sourceTarget.dispatchEvent(
            new PointerEvent("pointerdown", {
              ...eventOpts,
              ...pointerMeta,
              button: 0,
              clientX: fromX,
              clientY: fromY,
              buttons: 1,
            })
          );
          sourceTarget.dispatchEvent(
            new MouseEvent("mousedown", {
              ...eventOpts,
              clientX: fromX,
              clientY: fromY,
              buttons: 1,
            })
          );

          try {
            // Drive the visible glyph and the synthetic move events from the
            // same arced coordinates each frame, paced by wall-clock elapsed
            // time, so the cursor travels with the drag instead of teleporting.
            const duration = payload.durationMs ?? 500;
            const seed = Math.random() * 1000;

            await new Promise<void>((resolve) => {
              let startTs: number | null = null;
              let pauseStartedAt: number | null = null;
              let pausedTotal = 0;

              function frame(timestamp: number) {
                const el = cursorRef.current;
                // Component unmounted mid-drag — stop the loop (also breaks the
                // reschedule-forever path when unmounted while paused).
                if (!el) {
                  resolve();
                  return;
                }
                if (startTs === null) startTs = timestamp;

                if (pausedRef.current) {
                  // Freeze progress: remember when the pause began, keep ticking.
                  if (pauseStartedAt === null) pauseStartedAt = timestamp;
                  requestAnimationFrame(frame);
                  return;
                }
                if (pauseStartedAt !== null) {
                  pausedTotal += timestamp - pauseStartedAt;
                  pauseStartedAt = null;
                }

                const elapsed = timestamp - startTs - pausedTotal;
                const t = duration > 0 ? Math.min(elapsed / duration, 1) : 1;
                const { x: cx, y: cy } = computeBezierPoint(fromX, fromY, toX, toY, seed, t);

                el.style.left = `${cx}px`;
                el.style.top = `${cy}px`;
                el.style.transform = "";

                const moveTarget = document.elementFromPoint(cx, cy) ?? sourceTarget;
                moveTarget.dispatchEvent(
                  new PointerEvent("pointermove", {
                    ...eventOpts,
                    ...pointerMeta,
                    button: -1,
                    clientX: cx,
                    clientY: cy,
                    buttons: 1,
                  })
                );
                moveTarget.dispatchEvent(
                  new MouseEvent("mousemove", { ...eventOpts, clientX: cx, clientY: cy, buttons: 1 })
                );

                if (t >= 1) {
                  posRef.current = { x: toX, y: toY };
                  resolve();
                  return;
                }
                requestAnimationFrame(frame);
              }

              requestAnimationFrame(frame);
            });
          } finally {
            // Release at target (guaranteed even on error)
            const releaseTarget = document.elementFromPoint(toX, toY) ?? toEl;
            releaseTarget.dispatchEvent(
              new PointerEvent("pointerup", {
                ...eventOpts,
                ...pointerMeta,
                button: 0,
                clientX: toX,
                clientY: toY,
                buttons: 0,
              })
            );
            releaseTarget.dispatchEvent(
              new MouseEvent("mouseup", { ...eventOpts, clientX: toX, clientY: toY, buttons: 0 })
            );
          }

          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    // --- pressKey handler: dispatch keydown/keyup on target ---
    cleanups.push(
      demo.onExecCommand("demo:exec-press-key", async (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as DemoPressKeyPayload & { requestId: string };
        try {
          await waitIfPaused();
          const modifiers = payload.modifiers ?? [];
          const mac = isMac();
          const opts: KeyboardEventInit = {
            key: payload.key,
            code: payload.code ?? payload.key,
            bubbles: true,
            cancelable: true,
            metaKey: modifiers.includes("meta") || (modifiers.includes("mod") && mac),
            ctrlKey: modifiers.includes("ctrl") || (modifiers.includes("mod") && !mac),
            shiftKey: modifiers.includes("shift"),
            altKey: modifiers.includes("alt"),
          };

          let target: EventTarget;
          if (payload.selector) {
            const el = document.querySelector(payload.selector);
            if (!el) {
              sendDone(payload.requestId, `Selector not found: ${payload.selector}`);
              return;
            }
            target = el;
          } else {
            target = document.activeElement ?? document.documentElement;
          }

          target.dispatchEvent(new KeyboardEvent("keydown", opts));
          target.dispatchEvent(new KeyboardEvent("keyup", opts));
          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    // --- waitForIdle handler: MutationObserver + getAnimations + terminal
    // onWriteParsed + video playback + double-rAF ---
    //
    // getAnimations() and the MutationObserver only see CSS/WAAPI animations and
    // DOM mutations. They are blind to two activity channels that paint outside
    // that pipeline: xterm WebGL canvas repaints (terminal output) and <video>
    // playback. Without covering those, waitForIdle reports idle while a terminal
    // is still streaming output or a video is mid-playback. We treat all three
    // channels as independent activity signals — idle requires every channel
    // quiet for settleMs simultaneously (see issue #10144).
    cleanups.push(
      demo.onExecCommand("demo:exec-wait-for-idle", async (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as DemoWaitForIdlePayload & { requestId: string };
        try {
          const settleMs = payload.settleMs ?? 300;
          const timeoutMs = payload.timeoutMs ?? 5000;

          await new Promise<void>((resolve, reject) => {
            const start = performance.now();
            let timer: ReturnType<typeof setTimeout>;
            let cleaned = false;
            // The settle confirmation runs across a double-rAF gap. Any activity
            // arriving inside that gap calls resetTimer(), which flips this flag
            // so the in-flight rAF chain aborts instead of falsely resolving.
            let rafCancelled = false;
            const demoOverlay = document.querySelector("[data-demo-overlay]");

            // Terminal output channel: subscribe to onWriteParsed on every live
            // terminal. onWriteParsed fires at most once per frame after an async
            // parse of terminal.write() completes — it never fires on cursor
            // blink, scroll, or focus, so it is the correct settle signal (unlike
            // onRender, which the blink cycle triggers continuously). We snapshot
            // the terminals at entry; demo scripts are sequential, so no new
            // terminal appears mid-wait.
            const terminalDisposables: Array<{ dispose: () => void }> = [];
            for (const panelId of usePanelStore.getState().panelIds) {
              const managed = terminalInstanceService.get(panelId);
              if (!managed) continue;
              try {
                terminalDisposables.push(managed.terminal.onWriteParsed(() => resetTimer()));
              } catch {
                // A terminal that disposes mid-snapshot cannot produce output.
              }
            }

            // Video channel: media events do not bubble, so listen in the capture
            // phase on document. The active set holds videos currently playing;
            // idle requires it to be empty. `waiting` (buffering) counts as
            // inactive so a stalled video can never permanently block idle —
            // `playing` re-fires and resets the timer if playback resumes.
            const activeVideos = new Set<HTMLVideoElement>();
            for (const video of document.querySelectorAll("video")) {
              if (!video.paused && !video.ended && video.readyState >= 3) {
                activeVideos.add(video);
              }
            }
            function onVideoPlaying(e: Event) {
              if (e.target instanceof HTMLVideoElement) {
                activeVideos.add(e.target);
                resetTimer();
              }
            }
            function onVideoInactive(e: Event) {
              if (e.target instanceof HTMLVideoElement) {
                activeVideos.delete(e.target);
                // A video stopping is a state change — restart the settle window
                // so idle requires settleMs of quiet *after* playback ceases.
                resetTimer();
              }
            }
            document.addEventListener("playing", onVideoPlaying, true);
            document.addEventListener("pause", onVideoInactive, true);
            document.addEventListener("ended", onVideoInactive, true);
            document.addEventListener("waiting", onVideoInactive, true);

            function cleanup() {
              if (cleaned) return;
              cleaned = true;
              clearTimeout(timer);
              observer.disconnect();
              for (const d of terminalDisposables) {
                try {
                  d.dispose();
                } catch {
                  // A throwing dispose must not strand the remaining teardown.
                }
              }
              document.removeEventListener("playing", onVideoPlaying, true);
              document.removeEventListener("pause", onVideoInactive, true);
              document.removeEventListener("ended", onVideoInactive, true);
              document.removeEventListener("waiting", onVideoInactive, true);
            }

            function isDemoOwned(el: Element | null): boolean {
              if (!el || !demoOverlay) return false;
              return demoOverlay.contains(el);
            }

            function check() {
              const hasAnimations = document.getAnimations().some((a) => {
                const state = a.playState as string;
                if (state !== "running" && state !== "pending") return false;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                const effect = a.effect as KeyframeEffect | null;
                // Skip demo-owned animations (cursor, overlay)
                if (effect?.target && isDemoOwned(effect.target as Element)) return false;
                // Skip infinite CSS animations (spinners, pulses, breathe effects)
                const timing = effect?.getComputedTiming?.();
                if (timing && timing.iterations === Infinity) return false;
                return true;
              });

              if (hasAnimations) {
                resetTimer();
                return;
              }

              // Drop videos that were removed from the DOM while playing without
              // firing pause/ended (e.g. a React conditional unmount) — they
              // would otherwise block idle until the timeout.
              for (const v of activeVideos) {
                if (!v.isConnected) activeVideos.delete(v);
              }

              // A video still playing means the page is not idle yet.
              if (activeVideos.size > 0) {
                resetTimer();
                return;
              }

              // Double rAF to ensure paint is complete. resetTimer() flips
              // rafCancelled if activity arrives before the chain completes.
              rafCancelled = false;
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  if (rafCancelled) return;
                  cleanup();
                  resolve();
                });
              });
            }

            function resetTimer() {
              rafCancelled = true;
              if (performance.now() - start > timeoutMs) {
                cleanup();
                reject(new Error("waitForIdle timed out"));
                return;
              }
              clearTimeout(timer);
              timer = setTimeout(check, settleMs);
            }

            const observer = new MutationObserver(() => resetTimer());
            observer.observe(document.documentElement, {
              attributes: true,
              childList: true,
              subtree: true,
              characterData: true,
            });

            resetTimer();
          });

          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-pause", (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as { requestId: string };
        pausedRef.current = true;
        sendDone(payload.requestId);
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-resume", (raw: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const payload = raw as unknown as { requestId: string };
        pausedRef.current = false;
        const resolvers = pauseResolversRef.current.splice(0);
        for (const resolve of resolvers) {
          resolve();
        }
        sendDone(payload.requestId);
      })
    );

    return () => {
      for (const cleanup of cleanups) cleanup();
      scrollAnimRef.current?.cancel();
      scrollAnimRef.current = null;
    };
  }, []);

  return (
    <div
      ref={cursorRef}
      data-demo-cursor
      style={{
        position: "fixed",
        left: "50%",
        top: "50%",
        zIndex: 99999,
        pointerEvents: "none",
        willChange: "transform, opacity",
        transformOrigin: "top left",
      }}
    >
      <div ref={svgWrapperRef} style={{ transformOrigin: "top left" }}>
        <svg
          width="20"
          height="25"
          viewBox="0 0 20 25"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.3))" }}
        >
          <path d={CURSOR_SVG_PATH} fill="white" stroke="rgba(0,0,0,0.6)" strokeWidth="1" />
        </svg>
        <div
          ref={rippleRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.3)",
            opacity: 0,
            pointerEvents: "none",
            transformOrigin: "center",
          }}
        />
      </div>
    </div>
  );
}

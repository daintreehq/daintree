import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import type {
  DemoMoveToPayload,
  DemoMoveToSelectorPayload,
  DemoTypePayload,
  DemoSetZoomPayload,
  DemoWaitForSelectorPayload,
  DemoSleepPayload,
} from "@shared/types/ipc/demo";

const CURSOR_SVG_PATH = "M2.5 1L17.5 13.5H9.5L14 22L11 23.5L6.5 15L2.5 19.5V1Z";

const FITTS_A = 100;
const FITTS_B = 200;
const FITTS_DEFAULT_W = 40;
const TWO_PHASE_THRESHOLD = 300;

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

function cubicBezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function computeBezierKeyframes(
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

  const offset = dist * (0.05 + Math.random() * 0.25);
  const sign = Math.random() > 0.5 ? 1 : -1;

  const p1x = fromX + dx * 0.33 + perpX * offset * sign;
  const p1y = fromY + dy * 0.33 + perpY * offset * sign;

  const p2x = fromX + dx * 0.8 + perpX * offset * 0.3 * sign + dx * 0.05;
  const p2y = fromY + dy * 0.8 + perpY * offset * 0.3 * sign + dy * 0.05;

  const jitterAmplitude = Math.min(2, dist * 0.003);
  const frames: Array<{ transform: string }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let x = cubicBezier(t, fromX, p1x, p2x, toX) - fromX;
    let y = cubicBezier(t, fromY, p1y, p2y, toY) - fromY;

    if (i > 0 && i < steps && jitterAmplitude > 0) {
      const noiseVal = (noise1D(i * 0.15 + seed) * 2 - 1) * jitterAmplitude;
      x += perpX * noiseVal;
      y += perpY * noiseVal;
    }

    frames.push({ transform: `translate(${x}px, ${y}px)` });
  }
  return frames;
}

export function DemoCursor() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const svgWrapperRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLDivElement>(null);
  const posRef = useRef({ x: 0, y: 0 });
  const pauseResolversRef = useRef<Array<() => void>>([]);
  const pausedRef = useRef(false);

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

        const lastBallistic = allKeyframes[splitIndex].transform;
        const match = lastBallistic.match(/translate\(([^p]+)px,\s*([^p]+)px\)/);
        const midX = fromX + (match ? parseFloat(match[1]) : dx * 0.8);
        const midY = fromY + (match ? parseFloat(match[2]) : dy * 0.8);
        el.style.left = `${midX}px`;
        el.style.top = `${midY}px`;
        el.style.transform = "";
        ballisticAnim.cancel();

        const acquisitionKeyframes = allKeyframes.slice(splitIndex).map((kf, i) => {
          if (i === 0) return { transform: "translate(0px, 0px)" };
          const m = kf.transform.match(/translate\(([^p]+)px,\s*([^p]+)px\)/);
          if (!m) return kf;
          const origX = parseFloat(m[1]) + fromX;
          const origY = parseFloat(m[2]) + fromY;
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
      } else {
        const keyframes = computeBezierKeyframes(fromX, fromY, targetX, targetY, steps, seed);
        const anim = el.animate(keyframes, {
          duration: totalDuration,
          easing: "ease-out",
          fill: "forwards",
        });
        await anim.finished;
        el.style.left = `${targetX}px`;
        el.style.top = `${targetY}px`;
        el.style.transform = "";
        anim.cancel();
      }

      posRef.current = { x: targetX, y: targetY };
    }

    cleanups.push(
      demo.onExecCommand("demo:exec-move-to", async (raw: Record<string, unknown>) => {
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
        const payload = raw as unknown as DemoMoveToSelectorPayload & { requestId: string };
        try {
          await waitIfPaused();

          const elements = document.querySelectorAll(payload.selector);
          let target: Element | null = null;
          for (const el of elements) {
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
            clickTarget.dispatchEvent(new MouseEvent("mousedown", { ...opts, buttons: 1 }));
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

    cleanups.push(
      demo.onExecCommand("demo:exec-set-zoom", async (raw: Record<string, unknown>) => {
        const payload = raw as unknown as DemoSetZoomPayload & { requestId: string };
        try {
          await waitIfPaused();
          const start = demo.getZoomFactor();
          const target = payload.factor;
          const duration = payload.durationMs ?? 300;

          if (duration <= 0) {
            demo.setZoomFactor(target);
            sendDone(payload.requestId);
            return;
          }

          await new Promise<void>((resolve) => {
            const startTime = performance.now();
            function step(now: number) {
              const t = Math.min((now - startTime) / duration, 1);
              const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
              demo.setZoomFactor(start + (target - start) * eased);
              if (t < 1) {
                requestAnimationFrame(step);
              } else {
                resolve();
              }
            }
            requestAnimationFrame(step);
          });
          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-wait-for-selector", async (raw: Record<string, unknown>) => {
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
        const payload = raw as unknown as DemoSleepPayload & { requestId: string };
        try {
          await pauseAwareDelay(payload.durationMs);
          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-pause", (raw: Record<string, unknown>) => {
        const payload = raw as unknown as { requestId: string };
        pausedRef.current = true;
        sendDone(payload.requestId);
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-resume", (raw: Record<string, unknown>) => {
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
    };
  }, []);

  return (
    <div
      ref={cursorRef}
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

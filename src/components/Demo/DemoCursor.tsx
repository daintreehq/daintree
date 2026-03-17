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

function getDemoApi() {
  return window.electron.demo!;
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
  steps = 30
): Array<{ transform: string }> {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Perpendicular vector (normalized)
  const perpX = dist > 0 ? -dy / dist : 0;
  const perpY = dist > 0 ? dx / dist : 0;

  // Random offset 5-30% of distance, both control points on the same side
  const offset = dist * (0.05 + Math.random() * 0.25);
  const sign = Math.random() > 0.5 ? 1 : -1;

  // P1: ~33% along the vector, offset perpendicular
  const p1x = fromX + dx * 0.33 + perpX * offset * sign;
  const p1y = fromY + dy * 0.33 + perpY * offset * sign;

  // P2: ~80% along the vector, smaller perpendicular offset, slight overshoot past target
  const p2x = fromX + dx * 0.8 + perpX * offset * 0.3 * sign + dx * 0.05;
  const p2y = fromY + dy * 0.8 + perpY * offset * 0.3 * sign + dy * 0.05;

  const frames: Array<{ transform: string }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = cubicBezier(t, fromX, p1x, p2x, toX) - fromX;
    const y = cubicBezier(t, fromY, p1y, p2y, toY) - fromY;
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
      durationMs: number
    ): Promise<void> {
      const el = cursorRef.current;
      if (!el) return;

      const fromX = posRef.current.x;
      const fromY = posRef.current.y;
      const keyframes = computeBezierKeyframes(fromX, fromY, targetX, targetY, 30);

      const anim = el.animate(keyframes, {
        duration: durationMs,
        easing: "linear",
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

          await animateCursor(targetX, targetY, payload.durationMs);
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

          const cps = payload.cps ?? 12;
          const delay = 1000 / cps;

          const cmView = EditorView.findFromDOM(target);
          if (cmView) {
            cmView.focus();
            for (const char of payload.text) {
              await waitIfPaused();
              const pos = cmView.state.selection.main.head;
              cmView.dispatch({
                changes: { from: pos, insert: char },
                selection: { anchor: pos + char.length },
                annotations: Transaction.userEvent.of("input"),
              });
              await pauseAwareDelay(delay);
            }
          } else {
            const inputTarget = target as HTMLInputElement | HTMLTextAreaElement;
            inputTarget.focus();
            for (const char of payload.text) {
              await waitIfPaused();
              inputTarget.value += char;
              inputTarget.dispatchEvent(
                new InputEvent("input", { inputType: "insertText", data: char, bubbles: true })
              );
              await pauseAwareDelay(delay);
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

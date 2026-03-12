import { useEffect, useRef } from "react";
import type {
  DemoMoveToPayload,
  DemoTypePayload,
  DemoSetZoomPayload,
  DemoWaitForSelectorPayload,
} from "@shared/types/ipc/demo";

const CURSOR_SVG_PATH = "M2.5 1L17.5 13.5H9.5L14 22L11 23.5L6.5 15L2.5 19.5V1Z";

export function DemoCursor() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLDivElement>(null);
  const posRef = useRef({ x: 50, y: 50 });
  const pauseResolveRef = useRef<(() => void) | null>(null);
  const pausedRef = useRef(false);

  useEffect(() => {
    const { ipcRenderer } = window.require("electron");

    function sendDone(channel: string, error?: string) {
      ipcRenderer.send("demo:command-done", { channel, error });
    }

    async function waitIfPaused(): Promise<void> {
      if (!pausedRef.current) return;
      return new Promise<void>((resolve) => {
        pauseResolveRef.current = resolve;
      });
    }

    async function handleMoveTo(_event: unknown, payload: DemoMoveToPayload) {
      const channel = "demo:exec-move-to";
      try {
        await waitIfPaused();
        const el = cursorRef.current;
        if (!el) {
          sendDone(channel);
          return;
        }

        const from = posRef.current;
        const anim = el.animate(
          [
            { left: `${from.x}%`, top: `${from.y}%` },
            { left: `${payload.x}%`, top: `${payload.y}%` },
          ],
          {
            duration: payload.durationMs,
            easing: "cubic-bezier(0.4, 0, 0.2, 1)",
            fill: "forwards",
          }
        );
        await anim.finished;
        posRef.current = { x: payload.x, y: payload.y };
        el.style.left = `${payload.x}%`;
        el.style.top = `${payload.y}%`;
        anim.cancel();
        sendDone(channel);
      } catch (err) {
        sendDone(channel, String(err));
      }
    }

    async function handleClick() {
      const channel = "demo:exec-click";
      try {
        await waitIfPaused();
        const el = cursorRef.current;
        const ripple = rippleRef.current;
        if (!el) {
          sendDone(channel);
          return;
        }

        // Scale down
        const pressAnim = el.animate([{ transform: "scale(1)" }, { transform: "scale(0.85)" }], {
          duration: 80,
          easing: "ease-in",
          fill: "forwards",
        });
        await pressAnim.finished;
        pressAnim.cancel();
        el.style.transform = "scale(0.85)";

        // Scale up + ripple
        const releaseAnim = el.animate([{ transform: "scale(0.85)" }, { transform: "scale(1)" }], {
          duration: 120,
          easing: "ease-out",
          fill: "forwards",
        });

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
        el.style.transform = "scale(1)";
        sendDone(channel);
      } catch (err) {
        sendDone(channel, String(err));
      }
    }

    async function handleType(_event: unknown, payload: DemoTypePayload) {
      const channel = "demo:exec-type";
      try {
        await waitIfPaused();
        const target = document.querySelector(payload.selector) as
          | HTMLInputElement
          | HTMLTextAreaElement
          | null;
        if (!target) {
          sendDone(channel, `Selector not found: ${payload.selector}`);
          return;
        }

        target.focus();
        const cps = payload.cps ?? 12;
        const delay = 1000 / cps;

        for (const char of payload.text) {
          if (pausedRef.current) await waitIfPaused();
          target.value += char;
          target.dispatchEvent(
            new InputEvent("input", { inputType: "insertText", data: char, bubbles: true })
          );
          await new Promise((r) => setTimeout(r, delay));
        }
        sendDone(channel);
      } catch (err) {
        sendDone(channel, String(err));
      }
    }

    async function handleSetZoom(_event: unknown, payload: DemoSetZoomPayload) {
      const channel = "demo:exec-set-zoom";
      try {
        await waitIfPaused();
        const { webFrame } = window.require("electron");
        const start = webFrame.getZoomFactor();
        const target = payload.factor;
        const duration = payload.durationMs ?? 300;

        if (duration <= 0) {
          webFrame.setZoomFactor(target);
          sendDone(channel);
          return;
        }

        await new Promise<void>((resolve) => {
          const startTime = performance.now();
          function step(now: number) {
            const t = Math.min((now - startTime) / duration, 1);
            // easeInOutQuad
            const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
            webFrame.setZoomFactor(start + (target - start) * eased);
            if (t < 1) {
              requestAnimationFrame(step);
            } else {
              resolve();
            }
          }
          requestAnimationFrame(step);
        });
        sendDone(channel);
      } catch (err) {
        sendDone(channel, String(err));
      }
    }

    async function handleWaitForSelector(_event: unknown, payload: DemoWaitForSelectorPayload) {
      const channel = "demo:exec-wait-for-selector";
      try {
        if (document.querySelector(payload.selector)) {
          sendDone(channel);
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
        sendDone(channel);
      } catch (err) {
        sendDone(channel, String(err));
      }
    }

    function handlePause() {
      const channel = "demo:exec-pause";
      pausedRef.current = true;
      sendDone(channel);
    }

    function handleResume() {
      const channel = "demo:exec-resume";
      pausedRef.current = false;
      if (pauseResolveRef.current) {
        pauseResolveRef.current();
        pauseResolveRef.current = null;
      }
      sendDone(channel);
    }

    ipcRenderer.on("demo:exec-move-to", handleMoveTo);
    ipcRenderer.on("demo:exec-click", handleClick);
    ipcRenderer.on("demo:exec-type", handleType);
    ipcRenderer.on("demo:exec-set-zoom", handleSetZoom);
    ipcRenderer.on("demo:exec-wait-for-selector", handleWaitForSelector);
    ipcRenderer.on("demo:exec-pause", handlePause);
    ipcRenderer.on("demo:exec-resume", handleResume);

    return () => {
      ipcRenderer.removeListener("demo:exec-move-to", handleMoveTo);
      ipcRenderer.removeListener("demo:exec-click", handleClick);
      ipcRenderer.removeListener("demo:exec-type", handleType);
      ipcRenderer.removeListener("demo:exec-set-zoom", handleSetZoom);
      ipcRenderer.removeListener("demo:exec-wait-for-selector", handleWaitForSelector);
      ipcRenderer.removeListener("demo:exec-pause", handlePause);
      ipcRenderer.removeListener("demo:exec-resume", handleResume);
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
  );
}

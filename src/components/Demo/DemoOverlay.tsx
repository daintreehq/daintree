import { useEffect, useRef, useState, useCallback } from "react";
import type { DemoSpotlightPayload, DemoAnnotatePayload, DemoDismissAnnotationPayload } from "@shared/types/ipc/demo";

interface SpotlightState {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AnnotationEntry {
  id: string;
  text: string;
  x: number;
  y: number;
  position: "top" | "bottom" | "left" | "right";
}

function getDemoApi() {
  return window.electron.demo!;
}

export function DemoOverlay() {
  const [spotlight, setSpotlight] = useState<SpotlightState | null>(null);
  const [annotations, setAnnotations] = useState<Map<string, AnnotationEntry>>(new Map());
  const spotlightAnimRef = useRef<{ cancel: () => void } | null>(null);
  const rectRef = useRef<SVGRectElement>(null);

  const animateSpotlightRect = useCallback(
    (target: SpotlightState) => {
      spotlightAnimRef.current?.cancel();
      const rect = rectRef.current;
      if (!rect) {
        setSpotlight(target);
        return;
      }

      // Spring-animate from current rect position to target
      const current = {
        x: parseFloat(rect.getAttribute("x") ?? "0"),
        y: parseFloat(rect.getAttribute("y") ?? "0"),
        width: parseFloat(rect.getAttribute("width") ?? "0"),
        height: parseFloat(rect.getAttribute("height") ?? "0"),
      };

      let cancelled = false;
      const stiffness = 70;
      const damping = 20;
      const vel = { x: 0, y: 0, width: 0, height: 0 };

      let lastTime = performance.now();
      function step(now: number) {
        if (cancelled) return;
        let dt = (now - lastTime) / 1000;
        dt = Math.min(dt, 0.032);
        lastTime = now;

        let settled = true;
        for (const key of ["x", "y", "width", "height"] as const) {
          const force = -stiffness * (current[key] - target[key]) - damping * vel[key];
          vel[key] += force * dt;
          current[key] += vel[key] * dt;
          if (Math.abs(vel[key]) > 0.5 || Math.abs(target[key] - current[key]) > 0.5) {
            settled = false;
          }
        }

        rect.setAttribute("x", String(current.x));
        rect.setAttribute("y", String(current.y));
        rect.setAttribute("width", String(Math.max(0, current.width)));
        rect.setAttribute("height", String(Math.max(0, current.height)));

        if (settled) {
          rect.setAttribute("x", String(target.x));
          rect.setAttribute("y", String(target.y));
          rect.setAttribute("width", String(target.width));
          rect.setAttribute("height", String(target.height));
        } else {
          requestAnimationFrame(step);
        }
      }

      spotlightAnimRef.current = {
        cancel: () => {
          cancelled = true;
        },
      };
      requestAnimationFrame(step);
      setSpotlight(target);
    },
    []
  );

  useEffect(() => {
    const demo = getDemoApi();
    const cleanups: Array<() => void> = [];

    function sendDone(requestId: string, error?: string) {
      demo.sendCommandDone(requestId, error);
    }

    cleanups.push(
      demo.onExecCommand("demo:exec-spotlight", (raw: Record<string, unknown>) => {
        const payload = raw as unknown as DemoSpotlightPayload & { requestId: string };
        try {
          const target = document.querySelector(payload.selector) as HTMLElement | null;
          if (!target) {
            sendDone(payload.requestId, `Selector not found: ${payload.selector}`);
            return;
          }

          const rect = target.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) {
            sendDone(payload.requestId, `Element has zero area: ${payload.selector}`);
            return;
          }

          const padding = payload.padding ?? 8;
          animateSpotlightRect({
            x: rect.left - padding,
            y: rect.top - padding,
            width: rect.width + padding * 2,
            height: rect.height + padding * 2,
          });
          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-dismiss-spotlight", (raw: Record<string, unknown>) => {
        const payload = raw as unknown as { requestId: string };
        spotlightAnimRef.current?.cancel();
        setSpotlight(null);
        sendDone(payload.requestId);
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-annotate", (raw: Record<string, unknown>) => {
        const payload = raw as unknown as DemoAnnotatePayload & { requestId: string; id: string };
        try {
          const target = document.querySelector(payload.selector) as HTMLElement | null;
          if (!target) {
            sendDone(payload.requestId, `Selector not found: ${payload.selector}`);
            return;
          }

          const rect = target.getBoundingClientRect();
          const position = payload.position ?? "top";
          let x: number;
          let y: number;

          switch (position) {
            case "top":
              x = rect.left + rect.width / 2;
              y = rect.top - 8;
              break;
            case "bottom":
              x = rect.left + rect.width / 2;
              y = rect.bottom + 8;
              break;
            case "left":
              x = rect.left - 8;
              y = rect.top + rect.height / 2;
              break;
            case "right":
              x = rect.right + 8;
              y = rect.top + rect.height / 2;
              break;
          }

          // Clamp to viewport
          x = Math.max(8, Math.min(x, window.innerWidth - 8));
          y = Math.max(8, Math.min(y, window.innerHeight - 8));

          setAnnotations((prev) => {
            const next = new Map(prev);
            next.set(payload.id, { id: payload.id, text: payload.text, x, y, position });
            return next;
          });
          sendDone(payload.requestId);
        } catch (err) {
          sendDone(payload.requestId, String(err));
        }
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-dismiss-annotation", (raw: Record<string, unknown>) => {
        const payload = raw as unknown as DemoDismissAnnotationPayload & { requestId: string };
        setAnnotations((prev) => {
          if (payload.id === undefined) return new Map();
          const next = new Map(prev);
          next.delete(payload.id);
          return next;
        });
        sendDone(payload.requestId);
      })
    );

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [animateSpotlightRect]);

  return (
    <div
      data-demo-overlay
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99998,
        pointerEvents: "none",
      }}
    >
      {spotlight && (
        <svg
          width="100%"
          height="100%"
          style={{ position: "absolute", inset: 0 }}
        >
          <defs>
            <mask id="demo-spotlight-mask">
              <rect width="100%" height="100%" fill="white" />
              <rect
                ref={rectRef}
                x={spotlight.x}
                y={spotlight.y}
                width={spotlight.width}
                height={spotlight.height}
                rx="8"
                fill="black"
              />
            </mask>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill="rgba(0,0,0,0.5)"
            mask="url(#demo-spotlight-mask)"
          />
        </svg>
      )}

      {Array.from(annotations.values()).map((ann) => {
        const style: React.CSSProperties = {
          position: "absolute",
          background: "rgba(0,0,0,0.85)",
          color: "white",
          padding: "6px 12px",
          borderRadius: "6px",
          fontSize: "13px",
          fontFamily: "system-ui, sans-serif",
          whiteSpace: "nowrap",
          pointerEvents: "none",
        };

        switch (ann.position) {
          case "top":
            style.left = ann.x;
            style.bottom = window.innerHeight - ann.y;
            style.transform = "translateX(-50%)";
            break;
          case "bottom":
            style.left = ann.x;
            style.top = ann.y;
            style.transform = "translateX(-50%)";
            break;
          case "left":
            style.right = window.innerWidth - ann.x;
            style.top = ann.y;
            style.transform = "translateY(-50%)";
            break;
          case "right":
            style.left = ann.x;
            style.top = ann.y;
            style.transform = "translateY(-50%)";
            break;
        }

        return (
          <div key={ann.id} style={style}>
            {ann.text}
          </div>
        );
      })}
    </div>
  );
}

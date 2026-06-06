import { useEffect, useRef, useState, useCallback } from "react";
import type {
  DemoSpotlightPayload,
  DemoAnnotatePayload,
  DemoAnnotationSize,
  DemoDismissAnnotationPayload,
} from "@shared/types/ipc/demo";

interface SpotlightState {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Resolved absolute placement of an annotation box. */
interface AnnotationPlacement {
  left: number;
  top: number;
  /** CSS transform translate offsets that anchor the box edge/center to (left, top). */
  tx: string;
  ty: string;
  textAlign: "left" | "center" | "right";
  /** Wider max-width for viewport "subtitle"/screen placements vs element/cursor callouts. */
  screenWide: boolean;
}

interface AnnotationEntry extends AnnotationPlacement {
  id: string;
  text: string;
  size: DemoAnnotationSize;
  /** True while fading out before removal. */
  exiting?: boolean;
}

// Caption height as a fraction of frame height so sizes scale across 1080p/4K.
// (Broadcast caption guidance lands ~4–6.6%; software-demo captions sit a touch
// smaller. The legacy fixed 13px was ~1.2% — unreadable when scaled down.)
const SIZE_FRACTION: Record<DemoAnnotationSize, number> = {
  sm: 0.028,
  md: 0.038,
  lg: 0.05,
  xl: 0.066,
};

const SAFE_MARGIN = 0.05; // 5% title-safe margin (SMPTE ST 2046-1).
const ELEMENT_PLACEMENTS = new Set(["top", "bottom", "left", "right"]);
const CURSOR_PLACEMENTS = new Set(["above-cursor", "below-cursor"]);

// Spotlight look: dim + blur everything outside the highlighted rect. The dim is
// a touch heavier than a bare scrim and the blur pushes the background out of
// focus, so the highlight reads even on Daintree's dark UI.
const SPOTLIGHT_DIM = 0.6; // background tint alpha
const SPOTLIGHT_BLUR_PX = 7; // backdrop blur radius (CSS px)
const SPOTLIGHT_RADIUS = 12; // rounded-corner radius of the clear cutout

// Fade timing (ms) for appear/disappear — standard screencast conventions:
// captions snap in a touch faster (200ms) than the screen-wide spotlight (300ms),
// both ease-in-out, so nothing pops in instantly.
const CAPTION_FADE_MS = 200;
const SPOTLIGHT_FADE_MS = 300;
const FADE_KEYFRAMES =
  "@keyframes demoFadeIn{from{opacity:0}to{opacity:1}}" +
  "@keyframes demoFadeOut{from{opacity:1}to{opacity:0}}";

/**
 * Build a CSS mask-image that is opaque everywhere EXCEPT a rounded-rect hole at
 * `s`, so a blurred/dimmed overlay shows everywhere but the spotlight. Uses an
 * evenodd path (outer frame rect + inner rounded rect) — the hole is transparent
 * (alpha 0), so the overlay is clipped away there and the real UI shows through
 * crisp. Coordinates are viewport CSS px (the overlay is a full-viewport box).
 */
function spotlightMaskImage(s: SpotlightState): string {
  const fw = window.innerWidth;
  const fh = window.innerHeight;
  const r = Math.max(0, Math.min(SPOTLIGHT_RADIUS, s.width / 2, s.height / 2));
  const x2 = s.x + s.width;
  const y2 = s.y + s.height;
  const hole =
    `M${s.x + r} ${s.y} H${x2 - r} A${r} ${r} 0 0 1 ${x2} ${s.y + r} ` +
    `V${y2 - r} A${r} ${r} 0 0 1 ${x2 - r} ${y2} ` +
    `H${s.x + r} A${r} ${r} 0 0 1 ${s.x} ${y2 - r} ` +
    `V${s.y + r} A${r} ${r} 0 0 1 ${s.x + r} ${s.y} Z`;
  const d = `M0 0 H${fw} V${fh} H0 Z ${hole}`;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${fw}' height='${fh}'>` +
    `<path fill-rule='evenodd' fill='#fff' d='${d}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function getDemoApi() {
  return window.electron.demo!;
}

/**
 * Resolve a placement string + optional target into absolute box coordinates.
 * Element placements need `selector`; cursor placements read the live demo
 * cursor; screen placements use the viewport. Anchors are clamped to the 5%
 * safe area. Returns an error string instead of throwing so the caller can
 * report it back over the demo command channel.
 */
function resolveAnnotationPlacement(
  payload: DemoAnnotatePayload
): AnnotationPlacement | { error: string } {
  const fw = window.innerWidth;
  const fh = window.innerHeight;
  const mx = fw * SAFE_MARGIN;
  const my = fh * SAFE_MARGIN;
  const gap = Math.max(16, fh * 0.02);
  const pos = payload.position ?? "top";

  // left/top/tx/ty are assigned on every branch below (both switches have a
  // default); textAlign/screenWide keep defaults that some screen cases reuse.
  let left: number;
  let top: number;
  let tx: string;
  let ty: string;
  let textAlign: "left" | "center" | "right" = "center";
  let screenWide = false;

  if (ELEMENT_PLACEMENTS.has(pos) || CURSOR_PLACEMENTS.has(pos)) {
    let rect: DOMRect;
    if (CURSOR_PLACEMENTS.has(pos)) {
      const cur = document.querySelector("[data-demo-cursor]") as HTMLElement | null;
      if (!cur) return { error: "Demo cursor not found for cursor-anchored annotation" };
      rect = cur.getBoundingClientRect();
    } else {
      if (!payload.selector) return { error: `position "${pos}" requires a selector` };
      const el = document.querySelector(payload.selector) as HTMLElement | null;
      if (!el) return { error: `Selector not found: ${payload.selector}` };
      rect = el.getBoundingClientRect();
    }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    switch (pos) {
      case "left":
        left = rect.left - gap;
        top = cy;
        tx = "-100%";
        ty = "-50%";
        textAlign = "right";
        break;
      case "right":
        left = rect.right + gap;
        top = cy;
        tx = "0";
        ty = "-50%";
        textAlign = "left";
        break;
      case "bottom":
      case "below-cursor":
        left = cx;
        top = rect.bottom + gap;
        tx = "-50%";
        ty = "0";
        textAlign = "center";
        break;
      default: // "top" / "above-cursor"
        left = cx;
        top = rect.top - gap;
        tx = "-50%";
        ty = "-100%";
        textAlign = "center";
        break;
    }
  } else {
    screenWide = true;
    switch (pos) {
      case "screen-top":
        left = fw / 2;
        top = my;
        tx = "-50%";
        ty = "0";
        break;
      case "screen-center":
        left = fw / 2;
        top = fh / 2;
        tx = "-50%";
        ty = "-50%";
        break;
      case "top-left":
        left = mx;
        top = my;
        tx = "0";
        ty = "0";
        textAlign = "left";
        break;
      case "top-right":
        left = fw - mx;
        top = my;
        tx = "-100%";
        ty = "0";
        textAlign = "right";
        break;
      case "lower-third-left":
      case "bottom-left":
        left = mx;
        top = fh - my;
        tx = "0";
        ty = "-100%";
        textAlign = "left";
        break;
      case "lower-third-right":
      case "bottom-right":
        left = fw - mx;
        top = fh - my;
        tx = "-100%";
        ty = "-100%";
        textAlign = "right";
        break;
      default: // "screen-bottom" (subtitle)
        left = fw / 2;
        top = fh - my;
        tx = "-50%";
        ty = "-100%";
        break;
    }
  }

  // Edge-aware clamp: keep the whole box inside the safe area. The simple
  // anchor clamp isn't enough — a centered caption (translate -50%) near a frame
  // edge still bleeds half its width off-screen. Estimate the box size from the
  // size tier + text length, derive its span from the translate anchors, and
  // shift it back inside the margins.
  const fontPx = Math.round(fh * SIZE_FRACTION[payload.size ?? "md"]);
  const padX = Math.round(fontPx * 0.85);
  const padY = Math.round(fontPx * 0.42);
  const maxBoxW = (screenWide ? 0.7 : 0.34) * fw;
  const estW = Math.min(maxBoxW, payload.text.length * fontPx * 0.55 + padX * 2);
  const lines = estW >= maxBoxW ? 2 : 1;
  const estH = fontPx * 1.3 * lines + padY * 2;

  const spanLeft = tx === "-50%" ? left - estW / 2 : tx === "-100%" ? left - estW : left;
  const spanTop = ty === "-50%" ? top - estH / 2 : ty === "-100%" ? top - estH : top;
  if (spanLeft < mx) left += mx - spanLeft;
  else if (spanLeft + estW > fw - mx) left -= spanLeft + estW - (fw - mx);
  if (spanTop < my) top += my - spanTop;
  else if (spanTop + estH > fh - my) top -= spanTop + estH - (fh - my);
  return { left, top, tx, ty, textAlign, screenWide };
}

export function DemoOverlay() {
  const [spotlightVisible, setSpotlightVisible] = useState(false);
  const [spotlightExiting, setSpotlightExiting] = useState(false);
  const [annotations, setAnnotations] = useState<Map<string, AnnotationEntry>>(new Map());
  const spotlightAnimRef = useRef<{ cancel: () => void } | null>(null);
  const spotlightExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const currentRectRef = useRef<SpotlightState | null>(null);

  const applyMask = useCallback((rect: SpotlightState) => {
    const node = overlayRef.current;
    if (!node) return;
    const url = spotlightMaskImage(rect);
    node.style.maskImage = url;
    node.style.webkitMaskImage = url;
  }, []);

  const animateSpotlightRect = useCallback(
    (target: SpotlightState) => {
      spotlightAnimRef.current?.cancel();
      // Cancel an in-flight fade-out if we're re-spotlighting mid-dismiss.
      if (spotlightExitTimerRef.current) {
        clearTimeout(spotlightExitTimerRef.current);
        spotlightExitTimerRef.current = null;
      }
      setSpotlightExiting(false);
      const start = currentRectRef.current;
      currentRectRef.current = target;
      setSpotlightVisible(true);

      // First spotlight (or not yet mounted): snap to target. The div renders
      // its mask from currentRectRef; apply imperatively too if already mounted.
      if (!start || !overlayRef.current) {
        applyMask(target);
        return;
      }

      // Spring-animate the cutout from the previous rect to the target.
      const current = { ...start };
      let cancelled = false;
      const stiffness = 70;
      const damping = 20;
      const vel = { x: 0, y: 0, width: 0, height: 0 };

      let lastTime = performance.now();
      function step(now: number) {
        if (cancelled || !overlayRef.current) return;
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

        const snap: SpotlightState = settled
          ? target
          : {
              x: current.x,
              y: current.y,
              width: Math.max(0, current.width),
              height: Math.max(0, current.height),
            };
        currentRectRef.current = snap;
        applyMask(snap);

        if (!settled) requestAnimationFrame(step);
      }

      spotlightAnimRef.current = {
        cancel: () => {
          cancelled = true;
        },
      };
      requestAnimationFrame(step);
    },
    [applyMask]
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
        // Fade the overlay out (keep the last mask frozen), then unmount.
        setSpotlightExiting(true);
        if (spotlightExitTimerRef.current) clearTimeout(spotlightExitTimerRef.current);
        spotlightExitTimerRef.current = setTimeout(() => {
          currentRectRef.current = null;
          setSpotlightVisible(false);
          setSpotlightExiting(false);
          spotlightExitTimerRef.current = null;
        }, SPOTLIGHT_FADE_MS);
        sendDone(payload.requestId);
      })
    );

    cleanups.push(
      demo.onExecCommand("demo:exec-annotate", (raw: Record<string, unknown>) => {
        const payload = raw as unknown as DemoAnnotatePayload & { requestId: string; id: string };
        try {
          const resolved = resolveAnnotationPlacement(payload);
          if ("error" in resolved) {
            sendDone(payload.requestId, resolved.error);
            return;
          }

          setAnnotations((prev) => {
            const next = new Map(prev);
            next.set(payload.id, {
              id: payload.id,
              text: payload.text,
              size: payload.size ?? "md",
              ...resolved,
            });
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
        const targetId = payload.id;
        // Mark exiting (triggers the fade-out animation), then drop after it
        // completes. The removal only fires for entries still exiting, so a
        // re-annotate during the fade safely cancels the removal.
        setAnnotations((prev) => {
          const next = new Map(prev);
          for (const [id, e] of next) {
            if (targetId === undefined || id === targetId) next.set(id, { ...e, exiting: true });
          }
          return next;
        });
        setTimeout(() => {
          setAnnotations((prev) => {
            const next = new Map(prev);
            for (const [id, e] of prev) {
              if ((targetId === undefined || id === targetId) && e.exiting) next.delete(id);
            }
            return next;
          });
        }, CAPTION_FADE_MS);
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
      <style>{FADE_KEYFRAMES}</style>
      {spotlightVisible && (
        <div
          ref={overlayRef}
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: `rgba(0,0,0,${SPOTLIGHT_DIM})`,
            backdropFilter: `blur(${SPOTLIGHT_BLUR_PX}px)`,
            WebkitBackdropFilter: `blur(${SPOTLIGHT_BLUR_PX}px)`,
            // Mask out the spotlight rect so it stays sharp and unblurred. The
            // animation loop updates this imperatively; the initial value here
            // covers the first mount.
            maskImage: currentRectRef.current
              ? spotlightMaskImage(currentRectRef.current)
              : undefined,
            WebkitMaskImage: currentRectRef.current
              ? spotlightMaskImage(currentRectRef.current)
              : undefined,
            // Fade the whole focus layer in/out (opacity owned by the animation
            // via fill-mode `both`, so it never flashes). A stable per-phase
            // string means re-renders don't restart it.
            animation: spotlightExiting
              ? `demoFadeOut ${SPOTLIGHT_FADE_MS}ms ease-in-out both`
              : `demoFadeIn ${SPOTLIGHT_FADE_MS}ms ease-in-out both`,
            pointerEvents: "none",
          }}
        />
      )}

      {Array.from(annotations.values()).map((ann) => {
        const fontSize = Math.round(window.innerHeight * SIZE_FRACTION[ann.size]);
        const style: React.CSSProperties = {
          position: "absolute",
          left: ann.left,
          top: ann.top,
          transform: `translate(${ann.tx}, ${ann.ty})`,
          background: "rgba(0,0,0,0.82)",
          color: "#fff",
          padding: `${Math.round(fontSize * 0.42)}px ${Math.round(fontSize * 0.85)}px`,
          borderRadius: Math.round(fontSize * 0.35),
          fontSize,
          lineHeight: 1.3,
          fontWeight: 600,
          fontFamily: "system-ui, sans-serif",
          textAlign: ann.textAlign,
          maxWidth: ann.screenWide ? "70vw" : "34vw",
          whiteSpace: "normal",
          textShadow: "0 2px 8px rgba(0,0,0,0.55)",
          boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
          // Fade each caption in on appear and out on dismiss (fill-mode `both`
          // avoids a flash; stable per-phase string avoids re-render restarts).
          animation: ann.exiting
            ? `demoFadeOut ${CAPTION_FADE_MS}ms ease-in-out both`
            : `demoFadeIn ${CAPTION_FADE_MS}ms ease-in-out both`,
          pointerEvents: "none",
        };

        return (
          <div key={ann.id} style={style}>
            {ann.text}
          </div>
        );
      })}
    </div>
  );
}

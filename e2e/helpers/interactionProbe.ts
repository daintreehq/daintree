/* eslint-disable @typescript-eslint/no-explicit-any -- probe globals are untyped in Playwright evaluate() */
import type { Page } from "@playwright/test";

/**
 * Renderer-side latency probe for click/keypress → on-screen result.
 *
 * `arm` installs capture-phase input listeners and a rAF loop that evaluates a
 * done-condition once per frame. The first trusted input event after arming is
 * the start (its `timeStamp`, so input-queue delay counts); the done time is
 * the rAF callback of the first frame in which the condition holds — the frame
 * that paints the result. Animations are not waited out: a dropdown that is
 * mounted and fading in counts as "shown", which is what the user perceives as
 * the response.
 *
 * All stamps are epoch milliseconds (`timeOrigin + now`) so a measurement can
 * start in one project view and finish in another.
 */
export type DoneCondition =
  | { kind: "visible"; selector: string; text?: string; minCount?: number }
  | { kind: "hidden"; selector: string }
  | { kind: "count"; selector: string; op: "<" | "<=" | "==" | ">="; n: number }
  | { kind: "attr"; selector: string; attr: string; value: string | null }
  | { kind: "focused"; selector: string }
  | { kind: "text"; selector: string; text: string }
  /** a grid/dock panel id not present at arm time, optionally with an inner selector visible or buffer text */
  | { kind: "newPanel"; inner?: string; bufferText?: string }
  /** this view is the one on screen and `inner` holds — for cross-view switches */
  | { kind: "shown"; inner: DoneCondition }
  | { kind: "all"; conds: DoneCondition[] }
  /** the visible-match count or text of `selector` differs from its value at arm time */
  | { kind: "changed"; selector: string };

export interface ProbeResult {
  /** input event → first frame where the condition held */
  doneMs: number;
  /** input event → first frame after input (≈ INP-style next paint) */
  firstFrameMs: number;
  /** long animation frames (≥50ms) overlapping the interaction */
  loafCount: number;
  loafMaxMs: number;
  /** longest blocking gap between consecutive frames during the interaction */
  maxFrameGapMs: number;
  inputType: string | null;
  timedOut: boolean;
}

const PROBE_SOURCE = String.raw`
(() => {
  if (window.__ilat) return;
  const epoch = (t) => performance.timeOrigin + t;
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  // Seen, not merely present: no ancestor sits at opacity 0 unless an
  // animation on it is already running (an enter fade that has begun counts;
  // a frame rendered transparent while waiting to start its fade does not).
  const seen = (el) => {
    if (!visible(el)) return false;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (getComputedStyle(n).opacity !== "0") continue;
      const running = n.getAnimations ? n.getAnimations().some((a) => a.playState === "running") : false;
      if (!running) return false;
    }
    return true;
  };
  const countSeen = (els, need) => {
    let n = 0;
    for (const el of els) {
      if (seen(el) && ++n >= need) return n;
    }
    return n;
  };
  const panelIds = () =>
    new Set(Array.from(document.querySelectorAll("[data-panel-id]")).map((e) => e.getAttribute("data-panel-id")));
  let armPanels = new Set();
  const signature = (sel) => {
    const els = Array.from(document.querySelectorAll(sel)).filter(visible);
    return els.length + "|" + els.slice(0, 12).map((e) => (e.textContent || "").slice(0, 80)).join("\u0001");
  };
  let armSignatures = new Map();
  const collectChanged = (c) => {
    if (!c) return;
    if (c.kind === "changed") armSignatures.set(c.selector, signature(c.selector));
    if (c.kind === "all") c.conds.forEach(collectChanged);
    if (c.kind === "shown") collectChanged(c.inner);
  };
  const check = (c) => {
    switch (c.kind) {
      case "all":
        return c.conds.every(check);
      case "changed":
        return signature(c.selector) !== armSignatures.get(c.selector);
      case "newPanel": {
        for (const el of document.querySelectorAll("[data-panel-id]")) {
          const id = el.getAttribute("data-panel-id");
          if (!id || armPanels.has(id) || !visible(el)) continue;
          if (c.inner && countSeen(el.querySelectorAll(c.inner), 1) < 1) continue;
          if (c.bufferText) {
            const read = window.__daintreeReadTerminalBuffer;
            if (!read || !String(read(id)).includes(c.bufferText)) continue;
          }
          return true;
        }
        return false;
      }
      case "shown":
        return document.visibilityState === "visible" && check(c.inner);
      case "visible": {
        let els = Array.from(document.querySelectorAll(c.selector));
        if (c.text) els = els.filter((e) => (e.textContent || "").includes(c.text));
        const need = c.minCount || 1;
        return countSeen(els, need) >= need;
      }
      case "hidden":
        return !Array.from(document.querySelectorAll(c.selector)).some(visible);
      case "count": {
        const n = Array.from(document.querySelectorAll(c.selector)).filter(visible).length;
        return c.op === "<" ? n < c.n : c.op === "<=" ? n <= c.n : c.op === "==" ? n === c.n : n >= c.n;
      }
      case "attr": {
        const el = document.querySelector(c.selector);
        return !!el && el.getAttribute(c.attr) === c.value;
      }
      case "focused": {
        const el = document.activeElement;
        return !!el && (el.matches(c.selector) || !!el.closest(c.selector));
      }
      case "text": {
        const el = document.querySelector(c.selector);
        return !!el && (el.textContent || "").includes(c.text);
      }
    }
    return false;
  };
  let loafs = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) loafs.push({ s: epoch(e.startTime), d: e.duration });
      if (loafs.length > 500) loafs = loafs.slice(-250);
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch {}
  window.__ilat = {
    arm(cond, timeoutMs) {
      // A previous arm abandoned by a failed scenario must not keep listening.
      if (window.__ilatDispose) window.__ilatDispose();
      const state = { inputTs: null, inputType: null, armTs: epoch(performance.now()) };
      armPanels = panelIds();
      armSignatures = new Map();
      collectChanged(cond);
      const onInput = (e) => {
        if (state.inputTs !== null || !e.isTrusted) return;
        state.inputTs = epoch(e.timeStamp);
        state.inputType = e.type;
      };
      const types = ["pointerdown", "mousedown", "keydown", "click", "input"];
      for (const t of types) window.addEventListener(t, onInput, { capture: true, passive: true });
      window.__ilatPending = new Promise((resolve) => {
        let firstFrame = null;
        let lastFrame = null;
        let maxGap = 0;
        const deadline = state.armTs + timeoutMs;
        let settled = false;
        let fallback = null;
        const detach = () => {
          for (const t of types) window.removeEventListener(t, onInput, { capture: true });
          if (fallback !== null) clearTimeout(fallback);
          window.__ilatDispose = null;
        };
        const finish = (doneTs, timedOut) => {
          if (settled) return;
          settled = true;
          detach();
          const start = state.inputTs ?? state.armTs;
          const overl = loafs.filter((l) => l.s + l.d >= start && l.s <= doneTs);
          resolve({
            doneMs: doneTs - start,
            firstFrameMs: firstFrame === null ? doneTs - start : firstFrame - start,
            loafCount: overl.length,
            loafMaxMs: overl.reduce((m, l) => Math.max(m, l.d), 0),
            maxFrameGapMs: maxGap,
            inputType: state.inputType,
            timedOut,
          });
        };
        // Frames stop in a hidden or stalled view; the deadline must not.
        fallback = setTimeout(() => finish(epoch(performance.now()), true), timeoutMs + 250);
        window.__ilatDispose = () => finish(epoch(performance.now()), true);
        const tick = () => {
          if (settled) return;
          const now = epoch(performance.now());
          if (state.inputTs !== null || state.external) {
            if (lastFrame !== null) maxGap = Math.max(maxGap, now - lastFrame);
            lastFrame = now;
            if (firstFrame === null) firstFrame = now;
            let ok = false;
            try { ok = check(cond); } catch {}
            if (ok) return finish(now, false);
          }
          if (now > deadline) return finish(now, true);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      window.__ilatState = state;
      return state.armTs;
    },
    // For triggers that do not arrive as DOM input in this page (IPC, menu).
    external(startEpoch) {
      const s = window.__ilatState;
      if (!s) return;
      s.inputTs = startEpoch;
      s.inputType = "external";
      s.external = true;
    },
    check,
  };
})();
`;

export async function installProbe(page: Page): Promise<void> {
  await page.evaluate(PROBE_SOURCE);
}

export async function armProbe(page: Page, cond: DoneCondition, timeoutMs = 15_000): Promise<void> {
  await installProbe(page);
  await page.evaluate(([c, t]) => (window as any).__ilat.arm(c, t), [cond, timeoutMs] as const);
}

export async function probeResult(page: Page): Promise<ProbeResult> {
  return page.evaluate(() => (window as any).__ilatPending as Promise<any>);
}

export async function checkCondition(page: Page, cond: DoneCondition): Promise<boolean> {
  await installProbe(page);
  return page.evaluate((c) => (window as any).__ilat.check(c), cond);
}

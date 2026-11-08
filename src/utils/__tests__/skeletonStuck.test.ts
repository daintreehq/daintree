// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = readFileSync(path.join(ROOT, "public/skeleton-stuck.js"), "utf8");
const INDEX = new DOMParser().parseFromString(
  readFileSync(path.join(ROOT, "index.html"), "utf8"),
  "text/html"
);
const SKELETON_HTML = INDEX.getElementById("startup-skeleton")!.outerHTML;

type Bridge = {
  restartInSafeMode?: ReturnType<typeof vi.fn>;
  reportStartupStuck?: ReturnType<typeof vi.fn>;
};

let visibility: DocumentVisibilityState;

function boot(app: Bridge | null): void {
  document.body.innerHTML = SKELETON_HTML;
  Reflect.set(window, "electron", app ? { app } : undefined);
  new Function(SCRIPT)();
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} is missing from the card markup`);
  return node;
}

function button(id: string): HTMLButtonElement {
  const node = el(id);
  if (!(node instanceof HTMLButtonElement)) throw new Error(`#${id} is not a button`);
  return node;
}

function revealCard(): void {
  document.querySelector(".skeleton-stuck")!.dispatchEvent(new Event("animationstart"));
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function buttons() {
  return {
    reload: button("skeleton-stuck-btn"),
    safeMode: button("skeleton-stuck-safe-mode-btn"),
    error: el("skeleton-stuck-error"),
  };
}

describe("skeleton-stuck.js", () => {
  beforeEach(() => {
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    Reflect.deleteProperty(window, "electron");
    // Drop the own-property override so the prototype getter applies again.
    Reflect.deleteProperty(document, "visibilityState");
  });

  describe("the card's reveal", () => {
    // The report rides the card's own reveal animation, which jsdom can't run;
    // these pin the CSS the script depends on.
    function stuckRules(): Array<{ style: CSSStyleDeclaration; media: string | null }> {
      const styleEl = document.createElement("style");
      styleEl.textContent = INDEX.querySelector("style")!.textContent;
      document.head.appendChild(styleEl);
      const out: Array<{ style: CSSStyleDeclaration; media: string | null }> = [];
      const walk = (rules: CSSRuleList, media: string | null): void => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSMediaRule) walk(rule.cssRules, rule.media.mediaText);
          else if (rule instanceof CSSStyleRule && rule.selectorText === ".skeleton-stuck") {
            out.push({ style: rule.style, media });
          }
        }
      };
      walk(styleEl.sheet!.cssRules, null);
      styleEl.remove();
      return out;
    }

    it("reveals the card by a delayed animation", () => {
      const base = stuckRules().filter((r) => r.media === null);
      expect(base).toHaveLength(1);
      expect(base[0]!.style.getPropertyValue("animation")).not.toBe("");
      expect(parseFloat(base[0]!.style.getPropertyValue("animation-delay"))).toBeGreaterThan(0);
    });

    it("keeps the reveal animation, and its delay, under reduced motion", () => {
      const reduced = stuckRules().filter((r) => r.media?.includes("reduced-motion"));
      expect(reduced.length).toBeGreaterThan(0);
      for (const { style } of reduced) {
        expect(style.getPropertyValue("animation")).not.toMatch(/none/);
        expect(style.getPropertyValue("animation-name")).not.toBe("none");
        expect(style.getPropertyValue("animation-delay")).toBe("");
      }
    });

    it("lifts the busy state when the card appears, and only then", () => {
      boot(null);
      const skeleton = el("startup-skeleton");
      expect(skeleton.getAttribute("aria-busy")).toBe("true");

      revealCard();

      expect(skeleton.getAttribute("aria-busy")).toBe("false");
    });

    it("leaves a finishing skeleton's busy state to its removal", () => {
      boot(null);
      const skeleton = el("startup-skeleton");
      skeleton.setAttribute("data-startup-stage", "ready");

      revealCard();

      expect(skeleton.getAttribute("aria-busy")).toBe("true");
    });
  });

  describe("restart in safe mode", () => {
    it("stays hidden without a bridge that can restart", () => {
      boot(null);
      expect(buttons().safeMode.hidden).toBe(true);
    });

    it("keeps both buttons disabled once the restart is under way", async () => {
      const restartInSafeMode = vi.fn(() => Promise.resolve({ started: true }));
      boot({ restartInSafeMode });
      const { reload, safeMode, error } = buttons();
      expect(safeMode.hidden).toBe(false);

      safeMode.click();
      await settle();

      expect(restartInSafeMode).toHaveBeenCalledTimes(1);
      expect(safeMode.disabled).toBe(true);
      expect(reload.disabled).toBe(true);
      expect(error.hidden).toBe(true);
    });

    it("hands both buttons back when nothing restarts", async () => {
      boot({ restartInSafeMode: vi.fn(() => Promise.resolve({ started: false })) });
      const { reload, safeMode, error } = buttons();

      safeMode.click();
      expect(safeMode.disabled).toBe(true);
      expect(reload.disabled).toBe(true);
      await settle();

      expect(safeMode.disabled).toBe(false);
      expect(reload.disabled).toBe(false);
      expect(error.hidden).toBe(true);
    });

    it.each([
      ["rejects", () => Promise.reject(new Error("write failed"))],
      [
        "throws",
        () => {
          throw new Error("bridge gone");
        },
      ],
    ])("says so and hands both buttons back when the request %s", async (_label, impl) => {
      boot({ restartInSafeMode: vi.fn(impl) });
      const { reload, safeMode, error } = buttons();

      safeMode.click();
      await settle();

      expect(safeMode.disabled).toBe(false);
      expect(reload.disabled).toBe(false);
      expect(error.hidden).toBe(false);
    });

    it("clears a failure's message when the user tries again", async () => {
      let accept: (value: { started: boolean }) => void = () => {};
      const restartInSafeMode = vi
        .fn()
        .mockImplementationOnce(() => Promise.reject(new Error("write failed")))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              accept = resolve;
            })
        );
      boot({ restartInSafeMode });
      const { reload, safeMode, error } = buttons();
      safeMode.click();
      await settle();
      expect(error.hidden).toBe(false);

      safeMode.click();

      expect(error.hidden).toBe(true);
      expect(safeMode.disabled).toBe(true);
      expect(reload.disabled).toBe(true);
      accept({ started: true });
      await settle();
      expect(safeMode.disabled).toBe(true);
    });
  });

  describe("stuck report", () => {
    it("reports once, when the card appears, with how far startup got", () => {
      const reportStartupStuck = vi.fn(() => Promise.resolve());
      boot({ reportStartupStuck });
      expect(reportStartupStuck).not.toHaveBeenCalled();

      revealCard();
      revealCard();

      expect(reportStartupStuck).toHaveBeenCalledTimes(1);
      expect(reportStartupStuck).toHaveBeenCalledWith("before-boot");
    });

    it("passes the stage the renderer recorded", () => {
      const reportStartupStuck = vi.fn(() => Promise.resolve());
      boot({ reportStartupStuck });
      el("startup-skeleton").setAttribute("data-startup-stage", "hydrating");

      revealCard();

      expect(reportStartupStuck).toHaveBeenCalledWith("hydrating");
    });

    it("stays quiet for a startup that already finished", () => {
      const reportStartupStuck = vi.fn(() => Promise.resolve());
      boot({ reportStartupStuck });
      el("startup-skeleton").setAttribute("data-startup-stage", "ready");

      revealCard();

      expect(reportStartupStuck).not.toHaveBeenCalled();
    });

    it("waits for a hidden view to be shown before reporting", () => {
      const reportStartupStuck = vi.fn(() => Promise.resolve());
      boot({ reportStartupStuck });
      visibility = "hidden";
      revealCard();
      expect(reportStartupStuck).not.toHaveBeenCalled();

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));

      expect(reportStartupStuck).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["finished", () => el("startup-skeleton").setAttribute("data-startup-stage", "ready")],
      ["was removed", () => el("startup-skeleton").remove()],
    ])("drops a hidden view's report when its startup %s before it was shown", (_l, finish) => {
      const reportStartupStuck = vi.fn(() => Promise.resolve());
      boot({ reportStartupStuck });
      visibility = "hidden";
      revealCard();

      finish();
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));

      expect(reportStartupStuck).not.toHaveBeenCalled();
    });

    it.each([
      [
        "throws",
        () => {
          throw new Error("bridge gone");
        },
      ],
      ["rejects", () => Promise.reject(new Error("main gone"))],
    ])("keeps the card working when the report %s", async (_label, impl) => {
      const reportStartupStuck = vi.fn(impl);
      const restartInSafeMode = vi.fn(() => Promise.resolve({ started: true }));
      const onError = vi.fn();
      window.addEventListener("error", onError);
      try {
        boot({ reportStartupStuck, restartInSafeMode });
        revealCard();
        await settle();

        expect(reportStartupStuck).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
        buttons().safeMode.click();
        expect(restartInSafeMode).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener("error", onError);
      }
    });
  });
});

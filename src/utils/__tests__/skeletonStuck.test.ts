// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = readFileSync(path.join(ROOT, "public/skeleton-stuck.js"), "utf8");
const SKELETON_HTML = (() => {
  const doc = new DOMParser().parseFromString(
    readFileSync(path.join(ROOT, "index.html"), "utf8"),
    "text/html"
  );
  return doc.getElementById("startup-skeleton")!.outerHTML;
})();

type Bridge = {
  restartInSafeMode?: ReturnType<typeof vi.fn>;
  reportStartupStuck?: ReturnType<typeof vi.fn>;
};

let visibility: DocumentVisibilityState;

function boot(app: Bridge | null): void {
  document.body.innerHTML = SKELETON_HTML;
  (window as unknown as { electron?: unknown }).electron = app ? { app } : undefined;
  new Function(SCRIPT)();
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function revealCard(): void {
  document.querySelector(".skeleton-stuck")!.dispatchEvent(new Event("animationstart"));
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    delete (window as unknown as { electron?: unknown }).electron;
  });

  describe("restart in safe mode", () => {
    it("stays hidden without a bridge that can restart", () => {
      boot(null);
      expect(el<HTMLButtonElement>("skeleton-stuck-safe-mode-btn").hidden).toBe(true);
    });

    it("keeps both buttons disabled once the restart is under way", async () => {
      const restartInSafeMode = vi.fn(() => Promise.resolve({ started: true }));
      boot({ restartInSafeMode });
      const safeMode = el<HTMLButtonElement>("skeleton-stuck-safe-mode-btn");
      expect(safeMode.hidden).toBe(false);

      safeMode.click();
      await settle();

      expect(restartInSafeMode).toHaveBeenCalledTimes(1);
      expect(safeMode.disabled).toBe(true);
      expect(el<HTMLButtonElement>("skeleton-stuck-btn").disabled).toBe(true);
      expect(el("skeleton-stuck-error").hidden).toBe(true);
    });

    it("hands the buttons back when nothing restarts", async () => {
      boot({ restartInSafeMode: vi.fn(() => Promise.resolve({ started: false })) });
      const safeMode = el<HTMLButtonElement>("skeleton-stuck-safe-mode-btn");

      safeMode.click();
      expect(safeMode.disabled).toBe(true);
      await settle();

      expect(safeMode.disabled).toBe(false);
      expect(el<HTMLButtonElement>("skeleton-stuck-btn").disabled).toBe(false);
      expect(el("skeleton-stuck-error").hidden).toBe(true);
    });

    it.each([
      ["rejects", () => Promise.reject(new Error("write failed"))],
      [
        "throws",
        () => {
          throw new Error("bridge gone");
        },
      ],
    ])("says so and hands the buttons back when the request %s", async (_label, impl) => {
      boot({ restartInSafeMode: vi.fn(impl) });
      const safeMode = el<HTMLButtonElement>("skeleton-stuck-safe-mode-btn");

      safeMode.click();
      await settle();

      expect(safeMode.disabled).toBe(false);
      expect(el("skeleton-stuck-error").hidden).toBe(false);
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
      expect(reportStartupStuck).toHaveBeenCalledWith("before-hydration");
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

    it("waits for a hidden view to be shown, and skips it if startup finished first", () => {
      const reportStartupStuck = vi.fn(() => Promise.resolve());
      boot({ reportStartupStuck });
      visibility = "hidden";
      revealCard();
      expect(reportStartupStuck).not.toHaveBeenCalled();

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(reportStartupStuck).toHaveBeenCalledTimes(1);

      boot({ reportStartupStuck: vi.fn() });
      const next = (window as unknown as { electron: { app: Bridge } }).electron.app;
      visibility = "hidden";
      revealCard();
      el("startup-skeleton").remove();
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(next.reportStartupStuck).not.toHaveBeenCalled();
    });

    it("keeps the card working when the report throws", () => {
      boot({
        reportStartupStuck: vi.fn(() => {
          throw new Error("bridge gone");
        }),
      });
      expect(() => revealCard()).not.toThrow();
    });
  });
});

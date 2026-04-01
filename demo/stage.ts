import type { Page } from "@playwright/test";
import type {
  DemoEncodePayload,
  DemoEncodeResult,
  DemoStartCapturePayload,
  DemoStartCaptureResult,
  DemoStopCaptureResult,
  DemoCaptureStatus,
} from "../shared/types/ipc/demo.js";

export type Scene = (stage: Stage) => Promise<void>;

export interface ScenarioConfig {
  outputFile: string;
  preset: DemoEncodePayload["preset"];
  fps?: number;
  scenes: Scene[];
}

export class Stage {
  private constructor(private readonly page: Page) {}

  static async create(page: Page): Promise<Stage> {
    await page.waitForFunction(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        return typeof w.electron !== "undefined" && typeof w.electron.demo !== "undefined";
      },
      undefined,
      { timeout: 15_000 }
    );
    return new Stage(page);
  }

  readonly cursor = {
    moveTo: async (
      selector: string,
      options?: { durationMs?: number; offsetX?: number; offsetY?: number }
    ): Promise<void> => {
      await this.page.evaluate(
        ([sel, dur, ox, oy]) =>
          (window as any).electron.demo.moveToSelector(sel, dur ?? 600, ox, oy),
        [selector, options?.durationMs, options?.offsetX, options?.offsetY] as const
      );
    },

    click: async (selector?: string): Promise<void> => {
      if (selector) {
        await this.cursor.moveTo(selector);
      }
      await this.page.evaluate(() => (window as any).electron.demo.click());
    },
  };

  readonly keyboard = {
    type: async (selector: string, text: string, options?: { cps?: number }): Promise<void> => {
      await this.page.evaluate(
        ([sel, txt, cps]) => (window as any).electron.demo.type(sel, txt, cps),
        [selector, text, options?.cps] as const
      );
    },
  };

  readonly camera = {
    zoom: async (factor: number, options?: { durationMs?: number }): Promise<void> => {
      await this.page.evaluate(([f, dur]) => (window as any).electron.demo.setZoom(f, dur), [
        factor,
        options?.durationMs,
      ] as const);
    },
  };

  readonly wait = {
    forSelector: async (selector: string, options?: { timeoutMs?: number }): Promise<void> => {
      await this.page.evaluate(
        ([sel, timeout]) => (window as any).electron.demo.waitForSelector(sel, timeout),
        [selector, options?.timeoutMs] as const
      );
    },
  };

  async sleep(ms: number): Promise<void> {
    await this.page.evaluate((dur) => (window as any).electron.demo.sleep(dur), ms);
  }

  async startCapture(payload: DemoStartCapturePayload): Promise<DemoStartCaptureResult> {
    return this.page.evaluate((p) => (window as any).electron.demo.startCapture(p), payload);
  }

  async stopCapture(): Promise<DemoStopCaptureResult> {
    return this.page.evaluate(() => (window as any).electron.demo.stopCapture());
  }

  async getCaptureStatus(): Promise<DemoCaptureStatus> {
    return this.page.evaluate(() => (window as any).electron.demo.getCaptureStatus());
  }

  async encode(payload: DemoEncodePayload): Promise<DemoEncodeResult> {
    return this.page.evaluate((p) => (window as any).electron.demo.encode(p), payload);
  }
}

import { vi } from "vitest";
import type { CanopyFrame } from "../canopyFrame";

/**
 * The decisions a test hosts the inbox with: the Canopy window's shape, every
 * decision a spy, overridable one at a time.
 */
export function canopyTestFrame(overrides: Partial<CanopyFrame> = {}): CanopyFrame {
  return {
    goToRun: vi.fn(),
    restoreElsewhere: vi.fn(),
    openAssistant: vi.fn(async () => null),
    takesTerminalSize: "on-use",
    ...overrides,
  };
}

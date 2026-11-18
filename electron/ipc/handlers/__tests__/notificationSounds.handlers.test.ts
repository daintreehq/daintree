import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMock = vi.hoisted(() => ({
  importCustomSound: vi.fn(async () => ({ id: "custom:x", label: "x" })),
  listCustomSounds: vi.fn(() => []),
  getCustomSoundsDir: vi.fn(() => "/user/sounds/custom"),
}));

vi.mock("../../../services/customNotificationSounds.js", () => serviceMock);

import { notificationSoundsNamespace } from "../notificationSounds.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";

const importSound = notificationSoundsNamespace.ops.importSound.handler as unknown as (
  payload: unknown
) => Promise<unknown>;

describe("notificationSounds IPC namespace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimitQueuesForTest();
  });

  it("hands the import to the catalog, which validates it", async () => {
    const payload = { label: "bell", wav: new Uint8Array(4) };

    await expect(importSound(payload)).resolves.toEqual({ id: "custom:x", label: "x" });
    expect(serviceMock.importCustomSound).toHaveBeenCalledWith(payload);
  });

  it("refuses a burst of imports before it writes any more files", async () => {
    for (let i = 0; i < 10; i++) await importSound({ label: "x", wav: new Uint8Array(4) });

    await expect(importSound({ label: "x", wav: new Uint8Array(4) })).rejects.toThrow(
      "Rate limit exceeded"
    );
    expect(serviceMock.importCustomSound).toHaveBeenCalledTimes(10);
  });
});

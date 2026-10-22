import { beforeEach, describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => ({ count: 0, disposed: 0 }));

vi.mock("../ElementPickerHost.js", () => ({
  ElementPickerHost: class {
    constructor() {
      constructed.count += 1;
    }
    async dispose() {
      constructed.disposed += 1;
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  constructed.count = 0;
  constructed.disposed = 0;
});

describe("the Element Picker host singleton", () => {
  it("creates nothing on shutdown when nothing asked for the host", async () => {
    const { shutdownElementPickerHost, getElementPickerHost } = await import("../index.js");
    await shutdownElementPickerHost();
    expect(constructed.count).toBe(0);
    await expect(getElementPickerHost()).rejects.toMatchObject({ code: "HOST_DISPOSED" });
    expect(constructed.count).toBe(0);
  });

  it("shares one instance and disposes it on shutdown", async () => {
    const { shutdownElementPickerHost, getElementPickerHost } = await import("../index.js");
    const [a, b] = await Promise.all([getElementPickerHost(), getElementPickerHost()]);
    expect(a).toBe(b);
    expect(constructed.count).toBe(1);
    await shutdownElementPickerHost();
    expect(constructed.disposed).toBe(1);
  });
});

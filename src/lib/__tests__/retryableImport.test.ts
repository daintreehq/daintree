import { describe, expect, it, vi } from "vitest";
import { retryableImport } from "../retryableImport";

describe("retryableImport", () => {
  it("loads once and serves the cached module afterwards", async () => {
    const load = vi.fn().mockResolvedValue({ id: "mod" });
    const importer = retryableImport(load);

    const [a, b] = await Promise.all([importer(), importer()]);
    const c = await importer();

    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(c).toBe(a);
  });

  it("re-imports after a rejection instead of replaying it", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"))
      .mockResolvedValue({ id: "mod" });
    const importer = retryableImport(load);

    await expect(importer()).rejects.toThrow("Failed to fetch");
    await expect(importer()).resolves.toEqual({ id: "mod" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("rejects every caller waiting on the same failed attempt", async () => {
    const load = vi.fn().mockRejectedValue(new Error("nope"));
    const importer = retryableImport(load);

    const results = await Promise.allSettled([importer(), importer()]);

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("peeks null until the module resolves", async () => {
    let release: (value: { id: string }) => void = () => {};
    const importer = retryableImport(() => new Promise<{ id: string }>((r) => (release = r)));

    const pending = importer();
    expect(importer.peek()).toBeNull();

    release({ id: "mod" });
    await pending;
    expect(importer.peek()).toEqual({ id: "mod" });
  });

  it("keeps peeking null after a failure", async () => {
    const importer = retryableImport(() => Promise.reject(new Error("nope")));

    await expect(importer()).rejects.toThrow("nope");

    expect(importer.peek()).toBeNull();
  });
});

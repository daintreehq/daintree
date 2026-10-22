import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getAppPath: () => "/app", isPackaged: false },
}));

import {
  CORE_GUEST_ASSET_DIR,
  CORE_GUEST_ASSET_FILES,
  MAX_CORE_GUEST_ASSET_BYTES,
  createCoreGuestAssetLoader,
  resolveCoreGuestAssetRoot,
} from "../guestAssets.js";

// The catalog is pinned to the build's own list in
// `scripts/__tests__/core-picker-assets.test.mjs`, which can import both.
describe("resolveCoreGuestAssetRoot", () => {
  it("resolves under the app path, which is the asar in a packaged build", () => {
    expect(resolveCoreGuestAssetRoot()).toBe(
      path.join("/app", "dist-electron", CORE_GUEST_ASSET_DIR)
    );
  });
});

describe("createCoreGuestAssetLoader", () => {
  function loader(
    options: {
      cache?: boolean;
      read?: (file: string) => Promise<string>;
      root?: string | null;
    } = {}
  ) {
    const read = vi.fn(options.read ?? (async (file: string) => `// ${file}`));
    const load = createCoreGuestAssetLoader({
      root: () => (options.root === undefined ? "/assets" : options.root),
      cache: options.cache ?? false,
      read,
    });
    return { load, read };
  }

  it("has nothing for a framework the build ships no extractor for", async () => {
    const { load, read } = loader();
    await expect(load("extractor:vue")).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("reads a listed asset from under the root", async () => {
    const { load, read } = loader();
    await expect(load("bootstrap")).resolves.toBe(
      `// ${path.join("/assets", CORE_GUEST_ASSET_FILES.bootstrap!)}`
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("shares one read between concurrent requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { load, read } = loader({
      read: async () => {
        await gate;
        return "body";
      },
    });
    const both = Promise.all([load("probe"), load("probe")]);
    release();
    await expect(both).resolves.toEqual(["body", "body"]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps a read only when the build cannot change under it", async () => {
    const dev = loader({ cache: false });
    await dev.load("probe");
    await dev.load("probe");
    expect(dev.read).toHaveBeenCalledTimes(2);

    const packaged = loader({ cache: true });
    await packaged.load("probe");
    await packaged.load("probe");
    expect(packaged.read).toHaveBeenCalledTimes(1);
  });

  it("retries a failed read rather than remembering the failure", async () => {
    let fail = true;
    const { load } = loader({
      cache: true,
      read: async () => {
        if (fail) throw new Error("ENOENT");
        return "body";
      },
    });
    await expect(load("bootstrap")).rejects.toThrow("could not be read");
    fail = false;
    await expect(load("bootstrap")).resolves.toBe("body");
  });

  it("refuses an empty or oversized asset, and an unresolvable root", async () => {
    await expect(loader({ read: async () => "" }).load("bootstrap")).rejects.toThrow("empty");
    await expect(
      loader({ read: async () => "x".repeat(MAX_CORE_GUEST_ASSET_BYTES + 1) }).load("bootstrap")
    ).rejects.toThrow("ceiling");
    await expect(loader({ root: null }).load("bootstrap")).rejects.toThrow("located");
  });
});

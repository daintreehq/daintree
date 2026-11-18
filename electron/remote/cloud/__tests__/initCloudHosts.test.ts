import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/nonexistent/daintree-cloud-init-test" },
}));
// The keychain is never touched before an account is connected; this keeps its store out of the test.
vi.mock("../CloudCredentialVault.js", () => ({ KeychainCloudCredentialVault: class {} }));

import { initCloudHosts } from "../initCloudHosts.js";

describe("initCloudHosts", () => {
  it("offers Google Cloud beside Boat, pinned to Google's own API in a packaged build", () => {
    let stored: unknown;
    const runtime = initCloudHosts({
      backend: {
        get: () => stored,
        set: (_key, value) => {
          stored = value;
        },
      },
      emit: vi.fn(),
    });
    try {
      const offered = runtime.cloudHosts.snapshot().providers.map((provider) => provider.name);
      expect(offered).toEqual(expect.arrayContaining(["Boat", "Google Cloud"]));
      expect(new URL(runtime.providers.apiUrlFor("gce")!).origin).toBe(
        "https://compute.googleapis.com"
      );
      // Nothing was asked of any provider, and nothing written, before an account exists.
      expect(stored).toBeUndefined();
    } finally {
      runtime.dispose();
    }
  });
});

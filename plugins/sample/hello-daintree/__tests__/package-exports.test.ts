import { describe, expect, it } from "vitest";

// The activate.test.ts contract test imports host code via relative `shared/`
// paths, so it never exercises the published package boundaries. This suite
// imports each package by its public name and `exports` subpath instead — the
// same resolution a plugin author gets after `npm install`. A broken `exports`
// map, missing `dist/` artifact, or dropped public export fails here, gating
// the publish before it ships a package that 404s on a subpath at install time.

describe("@daintreehq package boundaries resolve by public name", () => {
  it("plugin-sdk root exports its public runtime surface", async () => {
    const sdk = await import("@daintreehq/plugin-sdk");
    expect(typeof sdk.PLUGIN_PROCESS_STREAM_CHANNEL).toBe("string");
    expect(sdk.PLUGIN_PROCESS_STREAM_CHANNEL.length).toBeGreaterThan(0);
  });

  it("plugin-sdk/react subpath exports the React hooks", async () => {
    const react = await import("@daintreehq/plugin-sdk/react");
    expect(typeof react.useHostChannel).toBe("function");
    expect(typeof react.usePluginEvent).toBe("function");
  });

  it("plugin-testing exports createMockHost", async () => {
    const testing = await import("@daintreehq/plugin-testing");
    expect(typeof testing.createMockHost).toBe("function");
    // The factory must actually produce a usable mock host, not just exist.
    const host = testing.createMockHost({ pluginId: "daintree.hello" });
    expect(Array.isArray(host.registeredHandlers)).toBe(true);
  });

  it("plugin-vite exports the daintree plugin and React externals", async () => {
    const vite = await import("@daintreehq/plugin-vite");
    expect(typeof vite.daintreePlugin).toBe("function");
    expect(Array.isArray(vite.reactExternals)).toBe(true);
    expect(vite.daintreePlugin().name).toBe("daintree-plugin-vite");
  });
});

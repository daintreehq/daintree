import { describe, it, expect } from "vitest";
import { reactExternals, daintreePlugin } from "../index.js";

describe("@daintreehq/plugin-vite — reactExternals", () => {
  function matchesAny(specifier: string): boolean {
    return reactExternals.some((re) => re.test(specifier));
  }

  it("matches bare react and react-dom", () => {
    expect(matchesAny("react")).toBe(true);
    expect(matchesAny("react-dom")).toBe(true);
  });

  it("matches every documented React subpath", () => {
    expect(matchesAny("react/jsx-runtime")).toBe(true);
    expect(matchesAny("react/jsx-dev-runtime")).toBe(true);
    expect(matchesAny("react/compiler-runtime")).toBe(true);
    expect(matchesAny("react-dom/client")).toBe(true);
    expect(matchesAny("react-dom/server")).toBe(true);
  });

  it("does not match adjacent package names that share a prefix", () => {
    expect(matchesAny("reactive-lib")).toBe(false);
    expect(matchesAny("reactstrap")).toBe(false);
    expect(matchesAny("react-router")).toBe(false);
    expect(matchesAny("react-dom-stub")).toBe(false);
  });

  it("does not match scoped packages whose path contains 'react'", () => {
    expect(matchesAny("@scope/react")).toBe(false);
    expect(matchesAny("@types/react")).toBe(false);
    expect(matchesAny("preact")).toBe(false);
  });
});

describe("@daintreehq/plugin-vite — daintreePlugin", () => {
  it("returns a Vite plugin with the expected name", () => {
    const plugin = daintreePlugin();
    expect(plugin.name).toBe("daintree-plugin-vite");
    expect(typeof plugin.config).toBe("function");
  });

  it("contributes the React externals through the config hook", () => {
    const plugin = daintreePlugin();
    const configFn = plugin.config as unknown as () => {
      build: { rollupOptions: { external: ReadonlyArray<string | RegExp> } };
    };
    const result = configFn();
    expect(result.build.rollupOptions.external).toHaveLength(reactExternals.length);
    for (const re of reactExternals) {
      expect(result.build.rollupOptions.external).toContain(re);
    }
  });

  it("merges caller-supplied externals after the React preset", () => {
    const plugin = daintreePlugin({ externals: ["@host/shared-ui", /^@daintree\//] });
    const configFn = plugin.config as unknown as () => {
      build: { rollupOptions: { external: ReadonlyArray<string | RegExp> } };
    };
    const externals = configFn().build.rollupOptions.external;
    expect(externals).toContain("@host/shared-ui");
    expect(externals.length).toBe(reactExternals.length + 2);
  });
});

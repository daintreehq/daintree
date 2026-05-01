// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRUSTED_TYPES_POLICY_NAME } from "@shared/config/csp";

interface MockTrustedTypePolicy {
  createHTML: (input: string) => string;
}

interface MockTrustedTypes {
  createPolicy: ReturnType<typeof vi.fn>;
}

const installMockTrustedTypes = (): {
  createPolicySpy: ReturnType<typeof vi.fn>;
  createHTMLSpy: ReturnType<typeof vi.fn>;
} => {
  const createHTMLSpy = vi.fn((input: string) => input);
  const policy: MockTrustedTypePolicy = { createHTML: createHTMLSpy };
  const createPolicySpy = vi.fn(() => policy);
  const mock: MockTrustedTypes = { createPolicy: createPolicySpy };
  vi.stubGlobal("trustedTypes", mock);
  return { createPolicySpy, createHTMLSpy };
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("trustedTypesPolicy", () => {
  it("registers the daintree-svg named policy at module load", async () => {
    const { createPolicySpy } = installMockTrustedTypes();

    await import("../trustedTypesPolicy");

    expect(createPolicySpy).toHaveBeenCalledTimes(1);
    expect(createPolicySpy).toHaveBeenCalledWith(
      TRUSTED_TYPES_POLICY_NAME,
      expect.objectContaining({ createHTML: expect.any(Function) })
    );
  });

  it("createTrustedHTML delegates to the policy and passes input through", async () => {
    const { createHTMLSpy } = installMockTrustedTypes();

    const { createTrustedHTML } = await import("../trustedTypesPolicy");
    const result = createTrustedHTML("<svg></svg>");

    expect(createHTMLSpy).toHaveBeenCalledWith("<svg></svg>");
    expect(result).toBe("<svg></svg>");
  });

  it("setTrustedInnerHTML writes the trusted html to the element", async () => {
    installMockTrustedTypes();

    const { setTrustedInnerHTML, createTrustedHTML } = await import("../trustedTypesPolicy");
    const el = document.createElement("div");
    setTrustedInnerHTML(el, createTrustedHTML("<span>x</span>"));

    expect(el.innerHTML).toBe("<span>x</span>");
  });

  it("throws at import time when window.trustedTypes is missing", async () => {
    vi.stubGlobal("trustedTypes", undefined);

    await expect(import("../trustedTypesPolicy")).rejects.toThrow(/Trusted Types/);
  });
});

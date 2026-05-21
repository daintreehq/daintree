import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetBuiltinRendererRegistryForTests,
  getBuiltinView,
  registerBuiltinView,
  unregisterBuiltinView,
} from "../builtinRendererRegistry";

function StubComponent(): null {
  return null;
}

function OtherStubComponent(): null {
  return null;
}

describe("builtinRendererRegistry", () => {
  afterEach(() => {
    __resetBuiltinRendererRegistryForTests();
    vi.restoreAllMocks();
  });

  it("returns null for unregistered slots", () => {
    expect(getBuiltinView("github.bulkCreateWorktreeDialog")).toBeNull();
  });

  it("returns the registered component", () => {
    registerBuiltinView("github.issueSelector", StubComponent);
    expect(getBuiltinView("github.issueSelector")).toBe(StubComponent);
  });

  it("warns and overwrites when a slot is registered twice", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerBuiltinView("github.issueSelector", StubComponent);
    registerBuiltinView("github.issueSelector", OtherStubComponent);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("already registered"));
    expect(getBuiltinView("github.issueSelector")).toBe(OtherStubComponent);
  });

  it("unregisters slots and reports whether anything was removed", () => {
    registerBuiltinView("github.issueSelector", StubComponent);
    expect(unregisterBuiltinView("github.issueSelector")).toBe(true);
    expect(unregisterBuiltinView("github.issueSelector")).toBe(false);
    expect(getBuiltinView("github.issueSelector")).toBeNull();
  });
});

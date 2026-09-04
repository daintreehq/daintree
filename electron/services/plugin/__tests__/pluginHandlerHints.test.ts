import { describe, it, expect } from "vitest";
import {
  actionHandlerArityHint,
  appendHandlerHint,
  channelHandlerArityHint,
} from "../pluginHandlerHints.js";

const undefinedRead = new TypeError("Cannot read properties of undefined (reading 'worktreeId')");

describe("actionHandlerArityHint", () => {
  it("hints when a handler declares a context parameter it will never receive", () => {
    const hint = actionHandlerArityHint((_ctx: unknown, _args: unknown) => null, undefinedRead);
    expect(hint).toContain("only parameter");
  });

  it("stays quiet for the correct single-parameter shape", () => {
    expect(actionHandlerArityHint((_args: unknown) => null, undefinedRead)).toBeNull();
  });

  it("stays quiet for an unrelated failure, whatever the arity", () => {
    const hint = actionHandlerArityHint(
      (_ctx: unknown, _args: unknown) => null,
      new Error("network unreachable")
    );
    expect(hint).toBeNull();
  });

  it("covers the destructuring form of the same mistake", () => {
    const hint = actionHandlerArityHint(
      (_ctx: unknown, _args: unknown) => null,
      new TypeError("Cannot destructure property 'id' of 'undefined' as it is undefined.")
    );
    expect(hint).not.toBeNull();
  });
});

describe("channelHandlerArityHint", () => {
  it("hints when a handler declares one parameter and so is reading the context", () => {
    const hint = channelHandlerArityHint((_payload: unknown) => null, undefinedRead);
    expect(hint).toContain("(ctx, payload)");
  });

  it("stays quiet for the correct two-parameter shape", () => {
    expect(channelHandlerArityHint((_ctx: unknown, _payload: unknown) => null, undefinedRead)).toBe(
      null
    );
  });

  it("stays quiet for a variadic adapter, whose arity says nothing about the author", () => {
    // The typed-registration adapter is `(ctx, ...args)`, arity 1. The dispatch
    // site gates on that separately; this asserts the shapes stay distinct.
    const adapter = (_ctx: unknown, ..._args: unknown[]) => null;
    expect(adapter.length).toBe(1);
  });
});

describe("appendHandlerHint", () => {
  it("appends the hint to the error's own message", () => {
    const err = new TypeError("boom");
    appendHandlerHint(err, "Daintree hint: try the other parameter.");
    expect(err.message).toContain("boom");
    expect(err.message).toContain("try the other parameter");
  });

  it("preserves the error type and stack", () => {
    const err = new TypeError("boom");
    const stack = err.stack;
    appendHandlerHint(err, "Daintree hint: something.");
    expect(err).toBeInstanceOf(TypeError);
    expect(err.stack).toBe(stack);
  });

  it("does not accumulate across repeated dispatches of a shared error object", () => {
    const err = new TypeError("boom");
    appendHandlerHint(err, "Daintree hint: once.");
    appendHandlerHint(err, "Daintree hint: twice.");
    expect(err.message).not.toContain("twice");
    expect(err.message.split("Daintree hint:")).toHaveLength(2);
  });

  it("is a no-op for a null hint and for a non-Error throw", () => {
    const err = new Error("boom");
    appendHandlerHint(err, null);
    expect(err.message).toBe("boom");
    expect(() => appendHandlerHint("a string", "Daintree hint: x")).not.toThrow();
  });
});

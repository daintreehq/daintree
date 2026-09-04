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

  it("cannot tell a variadic adapter from a one-parameter handler by arity alone", () => {
    // The typed-registration adapter is `(ctx, ...args)` — rest parameters do
    // not count toward `length`, so it reports arity 1 exactly like the mistake
    // this hint describes. The helper therefore DOES fire on it, which is why
    // the dispatch site gates the channel hint on `!channelSchema` rather than
    // relying on arity. Asserting the false positive here is what keeps that
    // gate from being deleted as redundant.
    const adapter = (_ctx: unknown, ..._args: unknown[]) => null;
    expect(adapter.length).toBe(1);
    expect(channelHandlerArityHint(adapter, undefinedRead)).not.toBeNull();
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

  it("leaves a frozen error intact instead of throwing over it", () => {
    // A handler that throws a frozen Error would otherwise turn this
    // convenience into a TypeError that replaces the real failure — before the
    // audit record is written and before it is rethrown to the renderer.
    const err = Object.freeze(new TypeError("boom"));
    expect(() => appendHandlerHint(err, "Daintree hint: something.")).not.toThrow();
    expect(err.message).toBe("boom");
  });

  it("is a no-op for a null hint and for a non-Error throw", () => {
    const err = new Error("boom");
    appendHandlerHint(err, null);
    expect(err.message).toBe("boom");
    expect(() => appendHandlerHint("a string", "Daintree hint: x")).not.toThrow();
  });
});

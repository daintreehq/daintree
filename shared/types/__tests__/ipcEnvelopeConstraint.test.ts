import { describe, it, expectTypeOf } from "vitest";
import type { ForbidIpcEnvelopeKeys, IpcHandlerEnvelopeViolation } from "../ipc/errors.js";

describe("ForbidIpcEnvelopeKeys", () => {
  it("passes through primitive results unchanged", () => {
    expectTypeOf<ForbidIpcEnvelopeKeys<string>>().toEqualTypeOf<string>();
    expectTypeOf<ForbidIpcEnvelopeKeys<number>>().toEqualTypeOf<number>();
    expectTypeOf<ForbidIpcEnvelopeKeys<boolean>>().toEqualTypeOf<boolean>();
    expectTypeOf<ForbidIpcEnvelopeKeys<void>>().toEqualTypeOf<void>();
    expectTypeOf<ForbidIpcEnvelopeKeys<null>>().toEqualTypeOf<null>();
  });

  it("passes through object results that don't include forbidden keys", () => {
    expectTypeOf<ForbidIpcEnvelopeKeys<{ value: string }>>().toEqualTypeOf<{
      value: string;
    }>();
    expectTypeOf<ForbidIpcEnvelopeKeys<{ filePath: string; size: number }>>().toEqualTypeOf<{
      filePath: string;
      size: number;
    }>();
    expectTypeOf<ForbidIpcEnvelopeKeys<string[]>>().toEqualTypeOf<string[]>();
  });

  it("brands object types containing the 'ok' key", () => {
    expectTypeOf<
      ForbidIpcEnvelopeKeys<{ ok: true; data: string }>
    >().toEqualTypeOf<IpcHandlerEnvelopeViolation>();
    expectTypeOf<
      ForbidIpcEnvelopeKeys<{ ok: false; error: string }>
    >().toEqualTypeOf<IpcHandlerEnvelopeViolation>();
  });

  it("brands object types containing the 'success' key", () => {
    expectTypeOf<
      ForbidIpcEnvelopeKeys<{ success: boolean }>
    >().toEqualTypeOf<IpcHandlerEnvelopeViolation>();
    expectTypeOf<
      ForbidIpcEnvelopeKeys<{ success: false; error: string }>
    >().toEqualTypeOf<IpcHandlerEnvelopeViolation>();
  });

  it("brands an entire {ok: true} | {ok: false} union", () => {
    type Result = { ok: true; data: string } | { ok: false; error: string };
    expectTypeOf<ForbidIpcEnvelopeKeys<Result>>().toEqualTypeOf<IpcHandlerEnvelopeViolation>();
  });

  it("brands the object branch of a union with null/void/undefined (regression)", () => {
    // The previous `[T] extends [object]` outer guard short-circuited
    // when the union contained any non-object member, letting
    // `{ success: boolean } | null` (the webview:oauth-loopback result)
    // pass through unchanged. Switching to a distributive `T extends
    // object` evaluates each branch separately so the brand attaches
    // only to the object branch, surfacing the violation.
    expectTypeOf<
      ForbidIpcEnvelopeKeys<{ success: boolean } | null>
    >().toEqualTypeOf<IpcHandlerEnvelopeViolation | null>();
    expectTypeOf<ForbidIpcEnvelopeKeys<{ ok: false; error: string } | undefined>>().toEqualTypeOf<
      IpcHandlerEnvelopeViolation | undefined
    >();
  });

  it("passes through unions of safe objects with null/void/undefined", () => {
    expectTypeOf<ForbidIpcEnvelopeKeys<{ value: string } | null>>().toEqualTypeOf<{
      value: string;
    } | null>();
    expectTypeOf<ForbidIpcEnvelopeKeys<{ value: string } | undefined>>().toEqualTypeOf<
      { value: string } | undefined
    >();
  });

  it("the violation brand carries the remediation hint as a key name", () => {
    // The brand's only property name is the human-readable error message,
    // so `tsc` surfaces it directly: 'Property "...message..." is missing'.
    type Hint = keyof IpcHandlerEnvelopeViolation;
    expectTypeOf<Hint>().toEqualTypeOf<"IPC handler must throw new AppError(...) instead of returning {ok|success: ...} — see #6020">();
  });
});

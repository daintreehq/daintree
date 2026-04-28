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

  it("the violation brand carries the remediation hint as a key name", () => {
    // The brand's only property name is the human-readable error message,
    // so `tsc` surfaces it directly: 'Property "...message..." is missing'.
    type Hint = keyof IpcHandlerEnvelopeViolation;
    expectTypeOf<Hint>().toEqualTypeOf<"IPC handler must throw new AppError(...) instead of returning {ok|success: ...} — see #6020">();
  });
});

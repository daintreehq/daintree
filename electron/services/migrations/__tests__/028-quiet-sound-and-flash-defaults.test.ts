import { describe, expect, it, vi } from "vitest";
import { migration028 } from "../028-quiet-sound-and-flash-defaults.js";

function makeStoreMock(data: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration028.up>[0];
}

describe("migration028 — quiet sound and flash defaults", () => {
  it("has version 28", () => {
    expect(migration028.version).toBe(28);
  });

  it("flips a persisted soundEnabled:true to false and backfills flashEnabled:false", () => {
    const data: Record<string, unknown> = {
      notificationSettings: { enabled: true, soundEnabled: true },
    };
    const store = makeStoreMock(data);
    migration028.up(store);

    const after = data.notificationSettings as Record<string, unknown>;
    expect(after.soundEnabled).toBe(false);
    expect(after.flashEnabled).toBe(false);
  });

  it("forces a corrupted, non-boolean soundEnabled to false too", () => {
    const data: Record<string, unknown> = {
      notificationSettings: { soundEnabled: "true" },
    };
    const store = makeStoreMock(data);
    migration028.up(store);

    expect((data.notificationSettings as Record<string, unknown>).soundEnabled).toBe(false);
  });

  it("leaves an already-false soundEnabled alone", () => {
    const data: Record<string, unknown> = {
      notificationSettings: { soundEnabled: false, flashEnabled: false },
    };
    const store = makeStoreMock(data);
    migration028.up(store);

    expect(store.set).not.toHaveBeenCalled();
  });

  it("is idempotent — running twice does not re-apply", () => {
    const data: Record<string, unknown> = {
      notificationSettings: { soundEnabled: true },
    };
    const store = makeStoreMock(data);
    migration028.up(store);
    const firstCallCount = (store.set as ReturnType<typeof vi.fn>).mock.calls.length;

    migration028.up(store);
    const secondCallCount = (store.set as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(secondCallCount).toBe(firstCallCount);
  });

  it("no-op when notificationSettings is missing", () => {
    const store = makeStoreMock({});
    migration028.up(store);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("preserves unrelated fields, including a user's other customized settings", () => {
    const data: Record<string, unknown> = {
      notificationSettings: {
        soundEnabled: true,
        completedEnabled: true,
        completedSoundFile: "user-completed.wav",
      },
    };
    const store = makeStoreMock(data);
    migration028.up(store);

    const after = data.notificationSettings as Record<string, unknown>;
    expect(after.completedEnabled).toBe(true);
    expect(after.completedSoundFile).toBe("user-completed.wav");
  });
});

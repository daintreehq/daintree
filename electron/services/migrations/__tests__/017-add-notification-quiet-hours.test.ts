import { describe, expect, it, vi } from "vitest";
import { migration017 } from "../017-add-notification-quiet-hours.js";

function makeStoreMock(data: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    delete: vi.fn((key: string) => {
      delete data[key];
    }),
    _data: data,
  } as unknown as Parameters<typeof migration017.up>[0] & {
    _data: Record<string, unknown>;
  };
}

describe("migration017 — add notification quiet hours", () => {
  it("has version 17", () => {
    expect(migration017.version).toBe(17);
  });

  it("backfills all quiet-hours fields on an existing settings object", () => {
    const data: Record<string, unknown> = {
      notificationSettings: {
        enabled: true,
        completedEnabled: false,
      },
    };
    const store = makeStoreMock(data);
    migration017.up(store);

    const after = data.notificationSettings as Record<string, unknown>;
    expect(after.quietHoursEnabled).toBe(false);
    expect(after.quietHoursStartMin).toBe(22 * 60);
    expect(after.quietHoursEndMin).toBe(8 * 60);
    expect(after.quietHoursWeekdays).toEqual([]);
    expect(after.enabled).toBe(true);
    expect(after.completedEnabled).toBe(false);
  });

  it("is idempotent — running twice leaves migrated data intact", () => {
    const data: Record<string, unknown> = {
      notificationSettings: { enabled: true },
    };
    const store = makeStoreMock(data);
    migration017.up(store);
    const firstCallCount = (store.set as ReturnType<typeof vi.fn>).mock.calls.length;
    migration017.up(store);
    const secondCallCount = (store.set as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(secondCallCount).toBe(firstCallCount);
    const after = data.notificationSettings as Record<string, unknown>;
    expect(after.quietHoursEnabled).toBe(false);
    expect(after.quietHoursStartMin).toBe(22 * 60);
  });

  it("preserves existing quiet hours values when already set", () => {
    const data: Record<string, unknown> = {
      notificationSettings: {
        enabled: true,
        quietHoursEnabled: true,
        quietHoursStartMin: 21 * 60,
        quietHoursEndMin: 7 * 60,
        quietHoursWeekdays: [1, 2, 3],
      },
    };
    const store = makeStoreMock(data);
    migration017.up(store);

    const after = data.notificationSettings as Record<string, unknown>;
    expect(after.quietHoursEnabled).toBe(true);
    expect(after.quietHoursStartMin).toBe(21 * 60);
    expect(after.quietHoursEndMin).toBe(7 * 60);
    expect(after.quietHoursWeekdays).toEqual([1, 2, 3]);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("fills in missing fields without clobbering set ones", () => {
    const data: Record<string, unknown> = {
      notificationSettings: {
        enabled: true,
        quietHoursEnabled: true, // already set
      },
    };
    const store = makeStoreMock(data);
    migration017.up(store);

    const after = data.notificationSettings as Record<string, unknown>;
    expect(after.quietHoursEnabled).toBe(true);
    expect(after.quietHoursStartMin).toBe(22 * 60);
    expect(after.quietHoursEndMin).toBe(8 * 60);
    expect(after.quietHoursWeekdays).toEqual([]);
  });

  it("no-op when notificationSettings is missing", () => {
    const data: Record<string, unknown> = {};
    const store = makeStoreMock(data);
    expect(() => migration017.up(store)).not.toThrow();
    expect(store.set).not.toHaveBeenCalled();
  });

  it("no-op when notificationSettings is not an object", () => {
    for (const bad of [null, "nope", 42, []]) {
      const data: Record<string, unknown> = { notificationSettings: bad };
      const store = makeStoreMock(data);
      expect(() => migration017.up(store)).not.toThrow();
    }
  });

  it("preserves unrelated fields during backfill", () => {
    const data: Record<string, unknown> = {
      notificationSettings: {
        enabled: true,
        completedEnabled: true,
        soundEnabled: false,
        customField: "keep-me",
      },
    };
    const store = makeStoreMock(data);
    migration017.up(store);

    const after = data.notificationSettings as Record<string, unknown>;
    expect(after.enabled).toBe(true);
    expect(after.completedEnabled).toBe(true);
    expect(after.soundEnabled).toBe(false);
    expect(after.customField).toBe("keep-me");
    expect(after.quietHoursEnabled).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { migration008 } from "../008-split-notification-sounds.js";

function makeStoreMock(data: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration008.up>[0];
}

describe("migration008 — split notification sounds", () => {
  it("has version 8", () => {
    expect(migration008.version).toBe(8);
  });

  it("migrates soundFile to completedSoundFile and adds defaults", () => {
    const data: Record<string, unknown> = {
      notificationSettings: {
        enabled: true,
        soundFile: "custom.wav",
      },
    };
    const store = makeStoreMock(data);
    migration008.up(store);

    expect(store.set).toHaveBeenCalledWith("notificationSettings", {
      enabled: true,
      completedSoundFile: "custom.wav",
      waitingSoundFile: "waiting.wav",
      escalationSoundFile: "ping.wav",
    });
  });

  it("falls back to chime.wav when soundFile is missing on first run", () => {
    const data: Record<string, unknown> = {
      notificationSettings: { enabled: true },
    };
    const store = makeStoreMock(data);
    migration008.up(store);

    const after = data.notificationSettings as Record<string, unknown>;
    expect(after.completedSoundFile).toBe("chime.wav");
    expect(after.waitingSoundFile).toBe("waiting.wav");
    expect(after.escalationSoundFile).toBe("ping.wav");
  });

  it("preserves user-customized sounds on replay", () => {
    const data: Record<string, unknown> = {
      notificationSettings: {
        enabled: true,
        completedSoundFile: "user-completed.wav",
        waitingSoundFile: "user-waiting.wav",
        escalationSoundFile: "user-escalation.wav",
      },
    };
    const store = makeStoreMock(data);
    migration008.up(store);

    expect(store.set).not.toHaveBeenCalled();
    const after = data.notificationSettings as Record<string, unknown>;
    expect(after.completedSoundFile).toBe("user-completed.wav");
    expect(after.waitingSoundFile).toBe("user-waiting.wav");
    expect(after.escalationSoundFile).toBe("user-escalation.wav");
  });

  it("no-op when notificationSettings is missing", () => {
    const store = makeStoreMock({});
    migration008.up(store);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("preserves unrelated fields during migration", () => {
    const data: Record<string, unknown> = {
      notificationSettings: {
        enabled: true,
        completedEnabled: true,
        soundFile: "chime.wav",
        customField: "keep-me",
      },
    };
    const store = makeStoreMock(data);
    migration008.up(store);

    const after = data.notificationSettings as Record<string, unknown>;
    expect(after.enabled).toBe(true);
    expect(after.completedEnabled).toBe(true);
    expect(after.customField).toBe("keep-me");
    expect(after).not.toHaveProperty("soundFile");
  });
});

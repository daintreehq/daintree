import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeNotificationWav } from "../../../shared/utils/notificationSoundWav.js";

const userData = vi.hoisted(() => ({ dir: "" }));
const storeState = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  failNextSet: false,
  reads: 0,
}));
const fsState = vi.hoisted(() => ({ failAfterWrite: false }));

vi.mock("../../utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/fs.js")>();
  return {
    ...actual,
    // A write whose file is in place but whose directory sync then fails.
    resilientAtomicWriteFile: async (
      ...args: Parameters<typeof actual.resilientAtomicWriteFile>
    ) => {
      await actual.resilientAtomicWriteFile(...args);
      if (fsState.failAfterWrite) throw new Error("fsync failed");
    },
  };
});

vi.mock("electron", () => ({
  app: { getPath: (name: string) => (name === "userData" ? userData.dir : "") },
}));

vi.mock("../../store.js", () => ({
  store: {
    get: (key: string) => {
      storeState.reads++;
      return storeState.values[key];
    },
    set: (key: string, value: unknown) => {
      if (storeState.failNextSet) {
        storeState.failNextSet = false;
        throw new Error("disk full");
      }
      storeState.values[key] = value;
    },
  },
}));

const {
  getCustomSoundsDir,
  importCustomSound,
  isPlayableCustomSound,
  listCustomSounds,
  resolveCustomSoundPath,
} = await import("../customNotificationSounds.js");

const validWav = () => encodeNotificationWav(new Float32Array([0, 0.25, -0.25, 0]));

describe("customNotificationSounds", () => {
  beforeEach(() => {
    userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-sounds-"));
    storeState.values = {};
    storeState.failNextSet = false;
    storeState.reads = 0;
    fsState.failAfterWrite = false;
  });

  afterEach(() => {
    fs.rmSync(userData.dir, { recursive: true, force: true });
  });

  it("stores an import under a generated id inside app data and lists it", async () => {
    const wav = validWav();
    const imported = await importCustomSound({ label: " Door\tbell ", wav });

    expect(imported.label).toBe("Door bell");
    const filePath = resolveCustomSoundPath(imported.id);
    expect(filePath).not.toBeNull();
    expect(path.dirname(filePath!)).toBe(path.join(userData.dir, "sounds", "custom"));
    expect(new Uint8Array(fs.readFileSync(filePath!))).toEqual(wav);
    expect(listCustomSounds()).toEqual([{ ...imported, available: true }]);
    expect(isPlayableCustomSound(imported.id)).toBe(true);
  });

  it("accepts the bytes as an ArrayBuffer as well as a typed array", async () => {
    const wav = validWav();
    const imported = await importCustomSound({ label: "x", wav: wav.buffer });

    expect(resolveCustomSoundPath(imported.id)).not.toBeNull();
  });

  it("keeps both of two imports made at once", async () => {
    const [a, b] = await Promise.all([
      importCustomSound({ label: "a", wav: validWav() }),
      importCustomSound({ label: "b", wav: validWav() }),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(listCustomSounds().map((s) => s.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(listCustomSounds()).toHaveLength(2);
  });

  it.each([
    ["no payload", null],
    ["no bytes", { label: "x" }],
    ["bytes that aren't the canonical WAV", { label: "x", wav: new Uint8Array(64) }],
    ["a string for bytes", { label: "x", wav: "RIFF" }],
  ])("refuses %s and writes nothing", async (_, payload) => {
    await expect(importCustomSound(payload)).rejects.toThrow();

    expect(storeState.values.customNotificationSounds).toBeUndefined();
    expect(fs.existsSync(getCustomSoundsDir())).toBe(false);
  });

  it("removes the stored file when the list can't be saved", async () => {
    storeState.failNextSet = true;

    await expect(importCustomSound({ label: "x", wav: validWav() })).rejects.toThrow("disk full");

    expect(fs.readdirSync(getCustomSoundsDir())).toEqual([]);
  });

  it("keeps a dotted label as the window sent it, across a later import's rewrite", async () => {
    const first = await importCustomSound({ label: "Door.v2", wav: validWav() });
    await importCustomSound({ label: "other", wav: validWav() });

    expect(first.label).toBe("Door.v2");
    expect(listCustomSounds().find((s) => s.id === first.id)?.label).toBe("Door.v2");
  });

  it("registers an import only once its file is written", async () => {
    const pending = importCustomSound({ label: "x", wav: validWav() });

    expect(storeState.values.customNotificationSounds).toBeUndefined();
    const imported = await pending;
    expect(listCustomSounds().map((s) => s.id)).toEqual([imported.id]);
  });

  it("removes the file when the write fails after the file is already in place", async () => {
    fsState.failAfterWrite = true;

    await expect(importCustomSound({ label: "x", wav: validWav() })).rejects.toThrow(
      "fsync failed"
    );

    expect(fs.readdirSync(getCustomSoundsDir())).toEqual([]);
    expect(storeState.values.customNotificationSounds).toBeUndefined();
  });

  it("reads the stored list once to list every import", async () => {
    for (let i = 0; i < 3; i++) await importCustomSound({ label: `s${i}`, wav: validWav() });
    storeState.reads = 0;

    expect(listCustomSounds()).toHaveLength(3);
    expect(storeState.reads).toBe(1);
  });

  it("falls back to a generic label when the name has nothing showable", async () => {
    const imported = await importCustomSound({ label: "\u202e\u200b \t", wav: validWav() });

    expect(imported.label).toBe("Custom sound");
  });

  it("resolves nothing for an id that is well formed but not registered here", async () => {
    const imported = await importCustomSound({ label: "x", wav: validWav() });
    const forged = "custom:0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e6f";
    fs.copyFileSync(
      resolveCustomSoundPath(imported.id)!,
      path.join(getCustomSoundsDir(), "0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e6f.wav")
    );

    expect(resolveCustomSoundPath(forged)).toBeNull();
    expect(isPlayableCustomSound(forged)).toBe(false);
  });

  it("reports a registered import whose file was deleted as unavailable", async () => {
    const imported = await importCustomSound({ label: "x", wav: validWav() });
    fs.rmSync(resolveCustomSoundPath(imported.id)!);

    expect(resolveCustomSoundPath(imported.id)).toBeNull();
    expect(listCustomSounds()).toEqual([{ ...imported, available: false }]);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a stored file replaced by a symlink",
    async () => {
      const imported = await importCustomSound({ label: "x", wav: validWav() });
      const filePath = resolveCustomSoundPath(imported.id)!;
      const outside = path.join(userData.dir, "outside.wav");
      fs.writeFileSync(outside, validWav());
      fs.rmSync(filePath);
      fs.symlinkSync(outside, filePath);

      expect(resolveCustomSoundPath(imported.id)).toBeNull();
    }
  );

  it("ignores malformed and duplicate entries in the stored list", () => {
    const id = "custom:0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e6f";
    storeState.values.customNotificationSounds = [
      { id, label: "first" },
      { id, label: "dupe" },
      { id: "custom:../../x", label: "bad" },
      "junk",
      null,
    ];

    expect(listCustomSounds()).toEqual([{ id, label: "first", available: false }]);
  });
});

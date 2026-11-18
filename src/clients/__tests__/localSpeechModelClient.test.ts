// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalSpeechModelStatus } from "@shared/types";
import {
  getLocalModelStatus,
  isLocalModelReady,
  readLocalModelStatus,
  resetLocalModelClientForTests,
  subscribeLocalModelStatus,
} from "../localSpeechModelClient";

const status = (state: LocalSpeechModelStatus["state"], receivedBytes = 0) => ({
  state,
  totalBytes: 100,
  receivedBytes,
});

function stub(read: () => Promise<LocalSpeechModelStatus>) {
  let push: ((status: LocalSpeechModelStatus) => void) | null = null;
  vi.stubGlobal("electron", {
    voiceInput: {
      getLocalModel: vi.fn(read),
      onLocalModelStatus: vi.fn((callback: (status: LocalSpeechModelStatus) => void) => {
        push = callback;
        return () => {};
      }),
    },
  });
  return { push: (next: LocalSpeechModelStatus) => push?.(next) };
}

afterEach(() => {
  resetLocalModelClientForTests();
  vi.unstubAllGlobals();
});

describe("localSpeechModelClient", () => {
  it("counts only a ready model as ready", async () => {
    stub(async () => status("downloading", 40));
    await readLocalModelStatus();
    expect(getLocalModelStatus()?.state).toBe("downloading");
    expect(isLocalModelReady()).toBe(false);
  });

  it("knows nothing until it reads, then reports what main said", async () => {
    stub(async () => status("ready", 100));
    expect(getLocalModelStatus()).toBeNull();
    expect(isLocalModelReady()).toBe(false);
    await readLocalModelStatus();
    expect(isLocalModelReady()).toBe(true);
  });

  it("keeps a push over a reply main sent before it", async () => {
    let answer!: (value: LocalSpeechModelStatus) => void;
    const { push } = stub(() => new Promise((resolve) => (answer = resolve)));
    const reading = readLocalModelStatus();
    push(status("ready", 100));
    answer(status("downloading", 40));
    expect(await reading).toEqual(status("ready", 100));
    expect(isLocalModelReady()).toBe(true);
  });

  it("tells every subscriber about each push until it unsubscribes", async () => {
    const { push } = stub(async () => status("absent"));
    const heard: string[] = [];
    const unsubscribe = subscribeLocalModelStatus((next) => heard.push(next.state));
    push(status("downloading", 10));
    unsubscribe();
    push(status("ready", 100));
    expect(heard).toEqual(["downloading"]);
    expect(getLocalModelStatus()?.state).toBe("ready");
  });
});

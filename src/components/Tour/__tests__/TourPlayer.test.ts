import { describe, expect, it } from "vitest";
import { AUDIO_WAIT_MS, TourPlayer, type TourAudio, type TourPlayerDeps } from "../TourPlayer";
import type { TourChapterTiming } from "../tourTypes";

class FakeAudio implements TourAudio {
  src: string;
  preload = "";
  currentTime = 0;
  muted = false;
  playing = false;
  playCalls = 0;
  /** Controls the next play(): resolve and start flowing, stay pending, or reject. */
  nextPlay: "flow" | "pending" | Error = "flow";
  pendingReject: ((error: Error) => void) | null = null;
  private handlers = new Map<string, Set<() => void>>();
  constructor(src: string) {
    this.src = src;
  }
  play(): Promise<void> {
    this.playCalls++;
    const mode = this.nextPlay;
    if (mode instanceof Error) return Promise.reject(mode);
    if (mode === "pending") {
      return new Promise((_resolve, reject) => {
        this.pendingReject = reject;
      });
    }
    this.playing = true;
    this.fire("playing");
    return Promise.resolve();
  }
  pause(): void {
    this.playing = false;
    this.pendingReject?.(Object.assign(new Error("interrupted"), { name: "AbortError" }));
    this.pendingReject = null;
  }
  addEventListener(type: string, listener: () => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.handlers.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const handler of this.handlers.get(type) ?? []) handler();
  }
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

function setup(timings: TourChapterTiming[], options: { muted?: boolean } = {}) {
  let now = 0;
  let frames: Array<() => void> = [];
  const audios: FakeAudio[] = [];
  const deps: TourPlayerDeps = {
    createAudio: (url) => {
      const audio = new FakeAudio(url);
      audios.push(audio);
      return audio;
    },
    now: () => now,
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: (id) => {
      frames[id - 1] = () => {};
    },
  };
  const player = new TourPlayer(timings, deps, options);
  const advance = (ms: number) => {
    now += ms;
    const pending = frames;
    frames = [];
    pending.forEach((cb) => cb());
  };
  return { player, audios, advance };
}

const silent = (duration: number): TourChapterTiming => ({
  duration,
  cues: {},
  captions: [],
  audioUrl: null,
});
const voiced = (duration: number, name: string): TourChapterTiming => ({
  ...silent(duration),
  audioUrl: `https://cdn.example/${name}.ogg`,
});

describe("TourPlayer", () => {
  it("runs a chapter without audio on the wall clock, flagged silent, to its duration", () => {
    const { player, advance } = setup([silent(2)]);
    expect(player.getState().silent).toBe(true);
    player.play();
    advance(500);
    expect(player.getTime()).toBeCloseTo(0.5);
    advance(2000);
    expect(player.getState().status).toBe("ended");
    expect(player.getTime()).toBe(2);
  });

  it("holds the timeline while narration loads, then follows the audio clock", () => {
    const { player, audios, advance } = setup([voiced(10, "a")]);
    player.play();
    advance(400);
    expect(player.getTime()).toBe(0);
    expect(player.getState().audioStatus).toBe("loading");

    audios[0]!.fire("canplaythrough");
    expect(audios[0]!.playing).toBe(true);
    audios[0]!.currentTime = 3.2;
    advance(16);
    expect(player.getTime()).toBe(3.2);
    expect(player.getState().silent).toBe(false);
  });

  it("starts silently when audio is slow, then the voice joins at the scene's position", () => {
    const { player, audios, advance } = setup([voiced(10, "a")]);
    player.play();
    advance(AUDIO_WAIT_MS + 1);
    advance(1000);
    expect(player.getTime()).toBeCloseTo(1);
    expect(player.getState().silent).toBe(true);

    audios[0]!.fire("canplaythrough");
    expect(audios[0]!.currentTime).toBeCloseTo(1);
    expect(audios[0]!.playing).toBe(true);
    expect(player.getState().silent).toBe(false);
  });

  it("falls back to the silent clock when audio fails, without jumping the timeline", () => {
    const { player, audios, advance } = setup([voiced(10, "a")]);
    player.play();
    audios[0]!.fire("canplaythrough");
    audios[0]!.currentTime = 2;
    advance(16);
    audios[0]!.fire("error");
    expect(player.getState()).toMatchObject({ audioStatus: "failed", silent: true });
    advance(500);
    expect(player.getTime()).toBeCloseTo(2.5);
  });

  it("holds through a buffering stall, then carries on silently and resyncs on recovery", () => {
    const { player, audios, advance } = setup([voiced(30, "a")]);
    player.play();
    audios[0]!.fire("canplaythrough");
    audios[0]!.currentTime = 2;
    advance(16);

    audios[0]!.fire("waiting");
    advance(AUDIO_WAIT_MS - 100);
    expect(player.getTime()).toBe(2);

    advance(200);
    advance(3000);
    expect(player.getTime()).toBeCloseTo(5, 0);
    expect(player.getState().silent).toBe(true);

    audios[0]!.fire("playing");
    expect(audios[0]!.currentTime).toBeCloseTo(player.getTime());
    expect(player.getState().silent).toBe(false);
  });

  it("treats a play interrupted by pause as cancelled, not failed", async () => {
    const { player, audios } = setup([voiced(10, "a")]);
    player.play();
    audios[0]!.nextPlay = "pending";
    audios[0]!.fire("canplaythrough");
    player.pause();
    await flush();
    expect(player.getState().audioStatus).toBe("ready");

    audios[0]!.nextPlay = "flow";
    player.play();
    expect(audios[0]!.playing).toBe(true);
  });

  it("treats a play interrupted by a chapter change as cancelled, not failed", async () => {
    const { player, audios } = setup([voiced(10, "a"), voiced(10, "b")]);
    player.play();
    audios[0]!.nextPlay = "pending";
    audios[0]!.fire("canplaythrough");
    player.next();
    await flush();
    player.previous();
    expect(player.getState().audioStatus).toBe("ready");
    expect(audios[0]!.playCalls).toBe(2);
  });

  it("goes silent when autoplay is refused, and retries on the next explicit play", async () => {
    const { player, audios, advance } = setup([voiced(10, "a")]);
    player.play();
    audios[0]!.nextPlay = Object.assign(new Error("no gesture"), { name: "NotAllowedError" });
    audios[0]!.fire("canplaythrough");
    await flush();
    expect(player.getState()).toMatchObject({ audioStatus: "failed", silent: true });
    advance(1000);
    expect(player.getTime()).toBeCloseTo(1);

    player.pause();
    audios[0]!.nextPlay = "flow";
    player.play();
    expect(audios[0]!.playing).toBe(true);
  });

  it("finishes the timeline's tail on the wall clock after the voice ends", () => {
    const { player, audios, advance } = setup([voiced(10.6, "a")]);
    player.play();
    audios[0]!.fire("canplaythrough");
    audios[0]!.currentTime = 10;
    advance(16);
    audios[0]!.fire("ended");
    advance(300);
    expect(player.getState().status).toBe("playing");
    expect(player.getTime()).toBeCloseTo(10.3);
    expect(player.getState().silent).toBe(false);
    advance(400);
    expect(player.getState().status).toBe("ended");
  });

  it("restarts the voice when seeking back after it ended", () => {
    const { player, audios, advance } = setup([voiced(10.6, "a")]);
    player.play();
    audios[0]!.fire("canplaythrough");
    audios[0]!.currentTime = 10;
    advance(16);
    audios[0]!.fire("ended");
    audios[0]!.playing = false;
    player.seek(4);
    expect(audios[0]!.currentTime).toBe(4);
    expect(audios[0]!.playing).toBe(true);
  });

  it("mutes the audio without changing the timeline", () => {
    const { player, audios } = setup([voiced(10, "a"), voiced(10, "b")]);
    player.play();
    player.setMuted(true);
    expect(audios.every((a) => a.muted)).toBe(true);
    expect(player.getState().status).toBe("playing");
  });

  it("applies a persisted mute to audio created later", () => {
    const { player, audios } = setup([voiced(10, "a")], { muted: true });
    player.play();
    expect(audios[0]!.muted).toBe(true);
  });

  it("loads nothing until the tour starts, then preloads every chapter", () => {
    const { player, audios } = setup([voiced(5, "a"), silent(5), voiced(5, "c")]);
    expect(audios).toHaveLength(0);
    player.play();
    expect(audios.map((a) => a.src)).toEqual([
      "https://cdn.example/a.ogg",
      "https://cdn.example/c.ogg",
    ]);
  });

  it("pauses the outgoing chapter and autoplays the next when advancing", () => {
    const { player, audios, advance } = setup([voiced(5, "a"), voiced(5, "b")]);
    player.play();
    audios[0]!.fire("canplaythrough");
    audios[1]!.fire("canplaythrough");
    advance(16);
    player.next();
    expect(audios[0]!.playing).toBe(false);
    expect(audios[1]!.playing).toBe(true);
    expect(player.getState()).toMatchObject({ chapterIndex: 1, status: "playing" });
    expect(player.getTime()).toBe(0);
  });

  it("clamps seeks and syncs the audio position", () => {
    const { player, audios } = setup([voiced(5, "a")]);
    player.play();
    audios[0]!.fire("canplaythrough");
    player.seek(99);
    expect(player.getTime()).toBe(5);
    expect(audios[0]!.currentTime).toBe(5);
    player.seek(-3);
    expect(player.getTime()).toBe(0);
  });

  it("replays from the start after ending", () => {
    const { player, advance } = setup([silent(1)]);
    player.play();
    advance(1500);
    expect(player.getState().status).toBe("ended");
    player.play();
    expect(player.getTime()).toBe(0);
    expect(player.getState().status).toBe("playing");
  });

  it("ignores a stale ready event from a chapter the user already left", () => {
    const { player, audios } = setup([voiced(5, "a"), voiced(5, "b")]);
    player.play();
    player.goTo(1);
    audios[0]!.fire("canplaythrough");
    expect(audios[0]!.playing).toBe(false);
    expect(player.getState().chapterIndex).toBe(1);
  });

  it("releases every audio element on dispose", () => {
    const { player, audios } = setup([voiced(5, "a"), voiced(5, "b")]);
    player.play();
    player.dispose();
    expect(audios.every((a) => a.src === "")).toBe(true);
  });
});

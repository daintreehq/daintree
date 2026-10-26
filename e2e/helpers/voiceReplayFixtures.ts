import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type ClipTag = "short" | "pause" | "long" | "vocab";

/**
 * One dictated agent prompt. `speech` is what the synthesiser says, written the
 * way a person says it ("N P M", "dash dash watch") with macOS `say` pause
 * markers; `reference` is the prompt the speaker meant, in written form.
 */
export interface ReplayClip {
  id: string;
  speech: string;
  reference: string;
  /** Project vocabulary the transcript must keep; scored as term recall. */
  terms: string[];
  tags: ClipTag[];
}

/**
 * Every clip is trimmed so speech starts on the first sample and ends on the
 * last, and the stop is pressed when the clip ends: the opening and closing
 * words of every clip are the start and stop cases.
 */
export const REPLAY_CLIPS: readonly ReplayClip[] = [
  {
    id: "zustand-selector",
    speech:
      "Zustand selector in the worktree store is returning a new array on every render, wrap it in use shallow.",
    reference:
      "Zustand selector in the worktree store is returning a new array on every render, wrap it in useShallow.",
    terms: ["Zustand", "useShallow"],
    tags: ["vocab"],
  },
  {
    id: "npm-test-watch",
    speech: "Run N P M test dash dash watch on the voice recording service test file.",
    reference: "Run npm test --watch on the VoiceRecordingService test file.",
    terms: ["npm", "--watch", "VoiceRecordingService"],
    tags: ["vocab"],
  },
  {
    id: "commit-and-push",
    speech: "Commit and push.",
    reference: "Commit and push.",
    terms: [],
    tags: ["short"],
  },
  {
    id: "path-after-pause",
    speech:
      "Open electron slash services slash voice. [[slnc 1500]] Then find where the web socket reconnects.",
    reference: "Open electron/services/voice. Then find where the WebSocket reconnects.",
    terms: ["electron/services/voice", "WebSocket"],
    tags: ["pause", "vocab"],
  },
  {
    id: "long-continuous",
    speech:
      "I want you to go through the open A I transcription provider and trace every path where audio arrives before the session is ready, then write a vitest test that sends three chunks during the handshake and proves every byte reaches the socket in order after the session dot updated event arrives.",
    reference:
      "I want you to go through the OpenAITranscriptionProvider and trace every path where audio arrives before the session is ready, then write a Vitest test that sends three chunks during the handshake and proves every byte reaches the socket in order after the session.updated event arrives.",
    terms: ["OpenAITranscriptionProvider", "Vitest", "session.updated"],
    tags: ["long", "vocab"],
  },
  {
    id: "long-then-pause",
    speech:
      "The project view manager evicts the least recently used view when memory is tight, but the renderer for that view keeps its xterm instances alive because nothing calls dispose on them when the web contents goes away. [[slnc 1200]] Find the leak and fix it.",
    reference:
      "The ProjectViewManager evicts the least recently used view when memory is tight, but the renderer for that view keeps its xterm instances alive because nothing calls dispose on them when the WebContents goes away. Find the leak and fix it.",
    terms: ["ProjectViewManager", "xterm", "WebContents"],
    tags: ["long", "pause", "vocab"],
  },
  {
    id: "rebase-develop",
    speech:
      "Rebase this branch onto origin slash develop and resolve the conflict in package dot json.",
    reference: "Rebase this branch onto origin/develop and resolve the conflict in package.json.",
    terms: ["origin/develop", "package.json"],
    tags: ["vocab"],
  },
  {
    id: "tailwind-token",
    speech:
      "Swap the hard coded hex colour for the text secondary token from Tailwind and check it in dark mode.",
    reference:
      "Swap the hard-coded hex colour for the text-secondary token from Tailwind and check it in dark mode.",
    terms: ["text-secondary", "Tailwind"],
    tags: ["vocab"],
  },
  {
    id: "typescript-error",
    speech:
      "Fix the TypeScript error T S two three four five in shared slash types slash I P C slash A P I dot T S.",
    reference: "Fix the TypeScript error TS2345 in shared/types/ipc/api.ts.",
    terms: ["TypeScript", "TS2345", "shared/types/ipc/api.ts"],
    tags: ["vocab"],
  },
  {
    id: "three-steps",
    speech:
      "First, read the failing test. [[slnc 1200]] Second, find the race. [[slnc 1200]] Third, fix it without adding a timeout.",
    reference:
      "First, read the failing test. Second, find the race. Third, fix it without adding a timeout.",
    terms: [],
    tags: ["pause"],
  },
  {
    id: "react-compiler",
    speech:
      "The React compiler bailed out on use terminal store, check the babel plugin output for the reason.",
    reference:
      "The React Compiler bailed out on useTerminalStore, check the Babel plugin output for the reason.",
    terms: ["React Compiler", "useTerminalStore", "Babel"],
    tags: ["vocab"],
  },
  {
    id: "playwright-spec",
    speech:
      "Write a Playwright spec under E 2 E slash full slash platform that presses command plus D and checks the mock gets audio.",
    reference:
      "Write a Playwright spec under e2e/full/platform that presses Command+D and checks the mock gets audio.",
    terms: ["Playwright", "e2e/full/platform"],
    tags: ["vocab"],
  },
  {
    id: "drizzle-migration",
    speech:
      "Add a drizzle migration with a project underscore I D column on the dictionary table, then run N P M run D B colon generate.",
    reference:
      "Add a Drizzle migration with a project_id column on the dictionary table, then run npm run db:generate.",
    terms: ["Drizzle", "project_id", "db:generate"],
    tags: ["vocab"],
  },
  {
    id: "deepgram-keyterm",
    speech:
      "Deepgram nova three rejects the keyterm parameter when the list is too long, so cap it before building the U R L.",
    reference:
      "Deepgram Nova-3 rejects the keyterm parameter when the list is too long, so cap it before building the URL.",
    terms: ["Deepgram", "Nova-3", "keyterm"],
    tags: ["vocab"],
  },
  {
    id: "pull-request",
    speech: "Looks good. [[slnc 900]] Open a pull request against develop.",
    reference: "Looks good. Open a pull request against develop.",
    terms: ["develop"],
    tags: ["short", "pause"],
  },
  {
    id: "ipc-codegen",
    speech:
      "Move the handler into electron slash I P C slash handlers and regenerate the preload types with codegen colon I P C.",
    reference:
      "Move the handler into electron/ipc/handlers and regenerate the preload types with codegen:ipc.",
    terms: ["electron/ipc/handlers", "codegen:ipc"],
    tags: ["vocab"],
  },
  {
    id: "xterm-webgl",
    speech:
      "The xterm web G L renderer drops glyphs after a resize, check the texture atlas size.",
    reference:
      "The xterm WebGL renderer drops glyphs after a resize, check the texture atlas size.",
    terms: ["xterm", "WebGL"],
    tags: ["vocab"],
  },
  {
    id: "node-pty-rebuild",
    speech:
      "Node P T Y fails to load after the electron upgrade, run N P M run rebuild and try again.",
    reference:
      "node-pty fails to load after the Electron upgrade, run npm run rebuild and try again.",
    terms: ["node-pty", "Electron", "npm run rebuild"],
    tags: ["vocab"],
  },
];

/** Every term across the fixture set, for configurations that seed them as dictionary entries. */
export function allFixtureTerms(clips: readonly ReplayClip[] = REPLAY_CLIPS): string[] {
  const seen = new Map<string, string>();
  for (const clip of clips) {
    for (const term of clip.terms) {
      if (!seen.has(term.toLowerCase())) seen.set(term.toLowerCase(), term);
    }
  }
  return [...seen.values()];
}

export const REPLAY_SAMPLE_RATE = 24_000;

export interface Pcm16 {
  sampleRate: number;
  samples: Int16Array;
}

/**
 * Reads a mono 16-bit PCM WAV, walking chunks rather than assuming a 44-byte
 * header: `say` writes an `FLLR` padding chunk before `data`.
 */
export function readPcm16Wav(buffer: Buffer): Pcm16 {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (format !== 1 || channels !== 1 || bits !== 16) {
        throw new Error(
          `expected mono 16-bit PCM, got format ${format}, ${channels} channel(s), ${bits}-bit`
        );
      }
      const end = Math.min(buffer.length, body + size);
      const samples = new Int16Array((end - body) >> 1);
      for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(body + i * 2);
      return { sampleRate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

export function encodePcm16Wav({ sampleRate, samples }: Pcm16): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i]!, i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Cuts leading and trailing samples quieter than `threshold` (of full scale). */
export function trimSilence(pcm: Pcm16, threshold = 0.01): Pcm16 {
  const floor = Math.round(threshold * 32768);
  let start = 0;
  let end = pcm.samples.length;
  while (start < end && Math.abs(pcm.samples[start]!) < floor) start++;
  while (end > start && Math.abs(pcm.samples[end - 1]!) < floor) end--;
  return { sampleRate: pcm.sampleRate, samples: pcm.samples.slice(start, end) };
}

export function pcmDurationMs(pcm: Pcm16): number {
  return Math.round((pcm.samples.length / pcm.sampleRate) * 1000);
}

/**
 * The longest stretch with no gap of at least `gapMs` below `threshold`: the
 * longest single utterance, which is what a forced commit cuts into.
 */
export function longestUtteranceMs(pcm: Pcm16, gapMs = 400, threshold = 0.01): number {
  const floor = Math.round(threshold * 32768);
  const gapSamples = Math.round((gapMs / 1000) * pcm.sampleRate);
  let longest = 0;
  let runStart = -1;
  let lastLoud = -1;
  for (let i = 0; i < pcm.samples.length; i++) {
    if (Math.abs(pcm.samples[i]!) < floor) continue;
    if (runStart === -1 || i - lastLoud > gapSamples) runStart = i;
    lastLoud = i;
    longest = Math.max(longest, lastLoud - runStart + 1);
  }
  return Math.round((longest / pcm.sampleRate) * 1000);
}

export interface PreparedClip {
  clip: ReplayClip;
  wavPath: string;
  source: "synthesised" | "recorded";
  audioMs: number;
  longestUtteranceMs: number;
}

export interface PrepareOptions {
  /** Synthesised WAVs are cached here by a hash of their speech and voice. */
  cacheDir: string;
  /** `<id>.wav` files here replace synthesis: real recordings, played as they are. */
  recordingsDir?: string;
  /** A macOS `say` voice; the system default when unset. */
  voice?: string;
}

/**
 * A WAV for each clip: a recording when one exists, otherwise speech from macOS
 * `say`, resampled by `say` itself to the 24 kHz mono s16le the voice pipeline
 * captures at, and trimmed so speech fills the clip edge to edge.
 */
export function prepareClip(clip: ReplayClip, options: PrepareOptions): PreparedClip {
  const recording = options.recordingsDir
    ? path.join(options.recordingsDir, `${clip.id}.wav`)
    : null;
  if (recording && existsSync(recording)) {
    const pcm = readPcm16Wav(readFileSync(recording));
    return {
      clip,
      wavPath: recording,
      source: "recorded",
      audioMs: pcmDurationMs(pcm),
      longestUtteranceMs: longestUtteranceMs(pcm),
    };
  }

  if (process.platform !== "darwin") {
    throw new Error(
      `no recording for clip "${clip.id}" and speech synthesis needs macOS \`say\`; ` +
        "put <id>.wav files in VOICE_REPLAY_RECORDINGS_DIR"
    );
  }
  mkdirSync(options.cacheDir, { recursive: true });
  const key = createHash("sha256")
    .update(`${options.voice ?? ""}\n${clip.speech}`)
    .digest("hex")
    .slice(0, 16);
  const wavPath = path.join(options.cacheDir, `${clip.id}-${key}.wav`);
  if (!existsSync(wavPath)) {
    const scratch = mkdtempSync(path.join(tmpdir(), "daintree-voice-replay-"));
    try {
      const raw = path.join(scratch, "raw.wav");
      execFileSync("say", [
        ...(options.voice ? ["-v", options.voice] : []),
        "-o",
        raw,
        "--file-format=WAVE",
        `--data-format=LEI16@${REPLAY_SAMPLE_RATE}`,
        clip.speech,
      ]);
      const trimmed = trimSilence(readPcm16Wav(readFileSync(raw)));
      if (trimmed.samples.length === 0)
        throw new Error(`\`say\` produced silence for "${clip.id}"`);
      writeFileSync(wavPath, encodePcm16Wav(trimmed));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const pcm = readPcm16Wav(readFileSync(wavPath));
  return {
    clip,
    wavPath,
    source: "synthesised",
    audioMs: pcmDurationMs(pcm),
    longestUtteranceMs: longestUtteranceMs(pcm),
  };
}

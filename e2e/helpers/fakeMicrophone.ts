import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { launchApp, type AppContext, type LaunchOptions } from "./launch";

const SAMPLE_RATE = 24_000;

export interface WavOptions {
  seconds: number;
  sampleRate?: number;
  /** Tone frequency in Hz; 0 writes silence. */
  frequency?: number;
  /** Peak amplitude, 0..1. */
  amplitude?: number;
  /** Sample value, -1..1, at `t` seconds; replaces the tone. */
  waveform?: (t: number) => number;
}

/** A mono 16-bit PCM WAV, the format Chromium's fake audio capture reads. */
export function buildWav({
  seconds,
  sampleRate = SAMPLE_RATE,
  frequency = 440,
  amplitude = 0.4,
  waveform,
}: WavOptions): Buffer {
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = waveform
      ? waveform(i / sampleRate)
      : frequency === 0
        ? 0
        : Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude;
    data.writeInt16LE(Math.round(v * 0x7fff), i * 2);
  }
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

export function writeWav(dir: string, name: string, options: WavOptions): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, buildWav(options));
  return file;
}

/**
 * Chromium switches that make a WAV the microphone. `%noloop` is Chromium's own suffix on the
 * file path: without it the capture device replays the file forever; with it the device goes
 * silent after the last sample.
 *
 * The audio service reads the file, and on macOS and Windows its sandbox refuses the read
 * ("Failed to read … as input to the fake device"), so the device stays silent. The app flag
 * has main lift that sandbox: `--no-sandbox` loses to `app.enableSandbox()`, and a launch
 * `--disable-features` to the app's own.
 */
export function fakeMicrophoneArgs(wavPath: string, loop = true): string[] {
  return [
    "--daintree-e2e-fake-microphone",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${wavPath}${loop ? "" : "%noloop"}`,
  ];
}

/**
 * macOS and Windows ask the OS about the microphone before the renderer reaches
 * getUserMedia, and the fake capture device never consults the OS. Answering
 * "granted" keeps a machine without microphone authorization from stalling the run.
 */
export async function stubNativeMicrophonePermission(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ systemPreferences }) => {
    systemPreferences.getMediaAccessStatus = () => "granted";
    systemPreferences.askForMediaAccess = async () => true;
  });
}

export interface FakeMicLaunchOptions extends LaunchOptions {
  wavPath: string;
  loop?: boolean;
}

export async function launchAppWithFakeMicrophone(
  options: FakeMicLaunchOptions
): Promise<AppContext> {
  const { wavPath, loop, extraArgs, ...rest } = options;
  return launchApp({
    ...rest,
    extraArgs: [...fakeMicrophoneArgs(wavPath, loop), ...(extraArgs ?? [])],
  });
}

/** Peak absolute sample of s16le PCM, 0..32768: proves real audio arrived rather than zero-fill. */
export function pcmPeak(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  return peak;
}

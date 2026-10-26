import { describe, expect, it } from "vitest";
import { buildWav, pcmPeak } from "../fakeMicrophone";
import { CHUNK_SAMPLES, glidingVoice, measureCoverage } from "../voiceCoverage";

const pcm = buildWav({ seconds: 2, waveform: glidingVoice }).subarray(44);
const chunks: Buffer[] = [];
for (let i = 0; i < pcm.length; i += CHUNK_SAMPLES * 2) {
  chunks.push(Buffer.from(pcm.subarray(i, i + CHUNK_SAMPLES * 2)));
}
// The voice starts at 0.25s: chunks 0-1 are silent, chunk 2 straddles the onset.
const SILENT_LEAD = 2;
const spoken = chunks.length - SILENT_LEAD;

describe("glidingVoice", () => {
  it("is silent before the onset and gives every spoken chunk different bytes", () => {
    expect(chunks.slice(0, SILENT_LEAD).map(pcmPeak)).toEqual([0, 0]);
    const spokenChunks = chunks.slice(SILENT_LEAD);
    expect(spokenChunks.every((chunk) => pcmPeak(chunk) > 1_000)).toBe(true);
    expect(new Set(spokenChunks.map((chunk) => chunk.toString("hex"))).size).toBe(spoken);
  });
});

describe("measureCoverage", () => {
  it("counts from the first non-silent chunk, so dropped leading silence is no loss", () => {
    expect(measureCoverage(chunks, chunks.slice(SILENT_LEAD))).toEqual({
      capturedChunks: spoken,
      repeatedChunks: 0,
      missingAtStart: 0,
      missingAtEnd: 0,
      missingInside: 0,
      missingMsAtStart: 0,
      missingMsAtEnd: 0,
    });
  });

  it("reports chunks lost at the start, the end and in between, in chunks and milliseconds", () => {
    const partialTail = chunks.at(-1)!.subarray(0, 1_200);
    const captured = [...chunks.slice(0, -1), partialTail];
    const received = [
      ...chunks.slice(SILENT_LEAD + 1, SILENT_LEAD + 6),
      ...chunks.slice(SILENT_LEAD + 7, -3),
    ];

    expect(measureCoverage(captured, received)).toEqual({
      capturedChunks: spoken,
      repeatedChunks: 0,
      missingAtStart: 1,
      missingAtEnd: 3,
      missingInside: 1,
      missingMsAtStart: 100,
      missingMsAtEnd: 225,
    });
  });

  it("accepts audio a replay sent again, but not a chunk that only arrived ahead of its place", () => {
    const [a, b, c, d] = chunks.slice(SILENT_LEAD, SILENT_LEAD + 4);
    expect(measureCoverage([a, b, c, d], [a, b, c, b, c, d])).toMatchObject({
      missingAtStart: 0,
      missingInside: 0,
      missingAtEnd: 0,
    });
    expect(measureCoverage([a, b, c, d], [a, c, b, d])).toMatchObject({ missingInside: 1 });
  });

  it("counts repeated captured chunks, and a single arrival covers only one of them", () => {
    const [voiced, next] = chunks.slice(SILENT_LEAD, SILENT_LEAD + 2);
    const silence = Buffer.alloc(CHUNK_SAMPLES * 2);
    const captured = [voiced, silence, voiced, next];
    expect(measureCoverage(captured, [voiced, silence, next])).toMatchObject({
      repeatedChunks: 1,
      missingInside: 1,
    });
  });

  it("treats a session whose audio never arrived as missing from the start", () => {
    expect(measureCoverage(chunks, [])).toMatchObject({
      capturedChunks: spoken,
      missingAtStart: spoken,
      missingMsAtStart: spoken * 100,
    });
  });
});

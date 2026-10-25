import { describe, expect, it } from "vitest";
import type { HostMetricsSummary } from "../../../../shared/types/remoteHosts.js";
import { waitFor } from "../../link/__tests__/linkTestUtils.js";
import { SummaryLoop } from "../summaryLoop.js";

describe("SummaryLoop sample age (#14462)", () => {
  it("dates a sample from when its read began, on this machine's clocks", async () => {
    let t = 1_000;
    let finish: ((summary: HostMetricsSummary) => void) | null = null;
    const loop = new SummaryLoop(
      {
        sample: () =>
          new Promise<HostMetricsSummary>((resolve) => {
            finish = resolve;
          }),
      },
      60_000,
      () => ({ wall: t, mono: t })
    );
    const off = loop.subscribe(() => {});
    const sampled = { sampledAt: 5 } as HostMetricsSummary;
    // A slow read counts toward the age.
    t = 3_000;
    finish!(sampled);
    await waitFor(() => loop.latest() === sampled);
    t = 4_000;
    expect(loop.ageOf(sampled)).toBe(3_000);
    expect(loop.receiptOf(sampled)).toEqual({
      receivedAt: 1_000,
      at: { wall: 1_000, mono: 1_000 },
      hostAgeMs: 0,
      maxAgeMs: 0,
    });
    // Only the summary it holds has an age here.
    expect(loop.ageOf({ ...sampled })).toBeNull();
    expect(loop.receiptOf({ ...sampled })).toBeNull();
    off();
    expect(loop.ageOf(sampled)).toBeNull();
  });
});

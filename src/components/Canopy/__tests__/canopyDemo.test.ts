import { describe, expect, it } from "vitest";
import { CANOPY_DEMO_ANSWER, CANOPY_DEMO_FRAME_COUNT, canopyDemoItems } from "../canopyDemo";
import { itemAwaitsPermission } from "../canopyModel";

const NOW = 1_700_000_000_000;

describe("canopyDemo", () => {
  it("puts the agent asking permission at the top of the list in its frame, and nowhere else", () => {
    for (let frame = 0; frame < CANOPY_DEMO_FRAME_COUNT; frame++) {
      const items = canopyDemoItems(frame, NOW);
      const asking = items.filter((item) => itemAwaitsPermission(item));
      if (frame === CANOPY_DEMO_ANSWER.frame) {
        expect(asking.map((item) => item.runId)).toEqual([CANOPY_DEMO_ANSWER.runId]);
        expect(items[0]!.runId).toBe(CANOPY_DEMO_ANSWER.runId);
        expect(items[0]!.card?.options).toContain(CANOPY_DEMO_ANSWER.option);
      } else {
        expect(asking).toEqual([]);
      }
    }
  });

  it("loops, and shows the same agents in every frame", () => {
    const ids = (frame: number) =>
      canopyDemoItems(frame, NOW)
        .map((item) => item.runId)
        .sort();
    for (let frame = 1; frame < CANOPY_DEMO_FRAME_COUNT; frame++)
      expect(ids(frame)).toEqual(ids(0));
    expect(canopyDemoItems(CANOPY_DEMO_FRAME_COUNT, NOW).map((item) => item.runId)).toEqual(
      canopyDemoItems(0, NOW).map((item) => item.runId)
    );
  });

  it("reads every card as current, so no row waits on words", () => {
    for (let frame = 0; frame < CANOPY_DEMO_FRAME_COUNT; frame++) {
      for (const item of canopyDemoItems(frame, NOW)) {
        expect(item.stale).toBe(false);
        expect(item.pending).toBe(false);
      }
    }
  });
});

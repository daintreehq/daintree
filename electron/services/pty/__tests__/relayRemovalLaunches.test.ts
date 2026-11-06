import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetRelayRemovalLaunchesForTesting,
  noteRelayRemovalLaunch,
  spoilRelayRemovalLaunch,
  takeRelayRemovalLaunch,
} from "../relayRemovalLaunches.js";

const ID = "daintree-decisions-remove-00000000-0000-4000-8000-000000000001";

describe("relay removal launches (#16202)", () => {
  beforeEach(() => _resetRelayRemovalLaunchesForTesting());

  it("hands a sent launch over once", () => {
    noteRelayRemovalLaunch(ID);
    expect(takeRelayRemovalLaunch(ID)).toBe(true);
    expect(takeRelayRemovalLaunch(ID)).toBe(false);
  });

  it.each([
    [
      "before",
      () => {
        spoilRelayRemovalLaunch(ID);
        noteRelayRemovalLaunch(ID);
      },
    ],
    [
      "after",
      () => {
        noteRelayRemovalLaunch(ID);
        spoilRelayRemovalLaunch(ID);
      },
    ],
  ])("never hands one over once a plain shell was spawned %s it", (_order, sequence) => {
    sequence();
    expect(takeRelayRemovalLaunch(ID)).toBe(false);
  });

  it("keeps ids apart", () => {
    noteRelayRemovalLaunch(ID);
    spoilRelayRemovalLaunch(`${ID.slice(0, -1)}2`);
    expect(takeRelayRemovalLaunch(ID)).toBe(true);
  });
});

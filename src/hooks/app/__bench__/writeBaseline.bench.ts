// @vitest-environment jsdom
import { bench, describe } from "vitest";
import { activityWrites, focusWrites, seedPanels } from "./panelSubscriberFixture";

seedPanels(true);

describe("store writes with no subscriber (floor)", () => {
  bench("1000 updateActivity writes", activityWrites);
  bench("1000 focus-only writes", focusWrites);
});

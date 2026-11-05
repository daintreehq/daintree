// @vitest-environment jsdom
import { test, describe } from "vitest";
import { activityWrites, focusWrites, seedPanels } from "./panelSubscriberFixture";

seedPanels(true);

describe("store writes with no subscriber (floor)", () => {
  test("1000 updateActivity writes", async ({ bench }) => {
    await bench("1000 updateActivity writes", activityWrites).run();
  });
  test("1000 focus-only writes", async ({ bench }) => {
    await bench("1000 focus-only writes", focusWrites).run();
  });
});

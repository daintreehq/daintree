// @vitest-environment jsdom
import { bench, describe, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { activityWrites, focusWrites, measureCalls, seedPanels } from "./panelSubscriberFixture";

vi.mock("@/store", async () => ({
  usePanelStore: (await import("./panelSubscriberFixture")).benchPanelStore,
}));
vi.mock("@shared/types/panel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/types/panel")>()),
  isPtyPanel: (await import("./panelSubscriberFixture")).countingIsPtyPanel,
}));
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: () => {} }) },
}));
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    isHibernated: () => false,
    subscribeHibernation: () => () => {},
  },
}));

import { useAccessibilityAnnouncements } from "../useAccessibilityAnnouncements";

seedPanels(true);
renderHook(() => useAccessibilityAnnouncements());

process.stderr.write(
  `[a11y] isPtyPanel calls — 1000 activity writes: ${measureCalls(activityWrites)}, 1000 focus writes: ${measureCalls(focusWrites)}\n`
);

describe("useAccessibilityAnnouncements subscriber (50 panels / 10 worktrees)", () => {
  bench("1000 updateActivity writes", activityWrites);
  bench("1000 focus-only writes", focusWrites);
});

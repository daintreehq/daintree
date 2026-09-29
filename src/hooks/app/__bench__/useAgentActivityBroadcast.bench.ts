// @vitest-environment jsdom
import { bench, describe, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { activityWrites, focusWrites, measureCalls, seedPanels } from "./panelSubscriberFixture";

vi.mock("@/store/panelStore", async () => ({
  usePanelStore: (await import("./panelSubscriberFixture")).benchPanelStore,
}));
vi.mock("@shared/types/panel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/types/panel")>()),
  isPtyPanel: (await import("./panelSubscriberFixture")).countingIsPtyPanel,
}));

import { useAgentActivityBroadcast } from "../useAgentActivityBroadcast";

Object.assign(window, {
  electron: {
    worktreePort: {
      request: () => Promise.resolve({ ok: true }),
      onReady: () => () => {},
    },
  },
});

seedPanels(true);
renderHook(() => useAgentActivityBroadcast());

process.stderr.write(
  `[broadcast] isPtyPanel calls — 1000 activity writes: ${measureCalls(activityWrites)}, 1000 focus writes: ${measureCalls(focusWrites)}\n`
);

describe("useAgentActivityBroadcast subscriber (50 panels / 10 worktrees)", () => {
  bench("1000 updateActivity writes", activityWrites);
  bench("1000 focus-only writes", focusWrites);
});

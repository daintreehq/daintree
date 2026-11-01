// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

// Status never arrives, as while Decisions reads it, so Connection never renders.
vi.mock("../useDecisions", () => ({
  useDecisions: () => ({
    status: null,
    pending: null,
    saveFailure: null,
    loadError: null,
    reload: vi.fn(),
    setEnabled: vi.fn(),
    applyStatus: vi.fn(),
  }),
}));

import { DecisionsSettingsTab } from "../DecisionsSettingsTab";
import { requestRelayUrl, takePendingRelayUrlRequest } from "../relayUrlRequest";

function settle() {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("Decisions page and a deploy pane's request for the relay URL", () => {
  afterEach(() => {
    cleanup();
    takePendingRelayUrlRequest();
  });

  it("keeps the request while the page is open, and drops it when Settings closes", async () => {
    requestRelayUrl();
    const { unmount } = render(
      <TooltipProvider>
        <DecisionsSettingsTab />
      </TooltipProvider>
    );
    await settle();

    unmount();
    await settle();

    expect(takePendingRelayUrlRequest()).toBe(false);
  });
});

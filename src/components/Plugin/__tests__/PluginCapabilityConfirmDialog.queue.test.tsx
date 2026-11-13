// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginCapabilityConfirmDialog } from "../PluginCapabilityConfirmDialog";
import {
  __resetPluginCapabilityConfirmStoreForTesting,
  requestPluginCapabilityConsent,
} from "@/store/pluginCapabilityConfirmStore";
import { EXTERNAL_LINK_CONSENT } from "@shared/types/pluginCapabilityConsent";
import type { PluginCapabilityConsentRequestEvent } from "@shared/types/pluginCapabilityConsent";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));
vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));
vi.mock("@/store/portalStore", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
  useOverlayState: () => {},
}));
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));
vi.mock("@/hooks/useHostConnection", () => ({
  useHostConnection: () => ({ hostId: null, hostName: null }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

// Longer than any read-time gate a dialog arms, so the first request's
// primary is live whatever the policy.
const PAST_ANY_COOLDOWN_MS = 5_000;
const PENDING_PROBE_MS = 20;

type Kind = "capability" | "restore" | "site";

function request(kind: Kind, requestId: string): PluginCapabilityConsentRequestEvent {
  const base = { requestId, pluginId: "acme.grid", pluginDisplayName: "Agent Grid" };
  switch (kind) {
    case "capability":
      return {
        ...base,
        capability: "shell:exec",
        declaredCapabilities: ["shell:exec", "git:write"],
      };
    case "restore":
      return {
        ...base,
        restore: ["terminal:read", "project:dispatch"],
        declaredCapabilities: ["terminal:read", "project:dispatch"],
      };
    case "site":
      return {
        ...base,
        capability: EXTERNAL_LINK_CONSENT,
        site: `${requestId}.example.com`,
        declaredCapabilities: [],
      };
  }
}

const PRIMARY_LABEL: Record<Kind, string> = {
  capability: "Allow and remember",
  restore: "Restore permissions",
  site: "Allow and remember",
};

// The permission grants are destructive and hold their primary for a read; the
// link prompt is not.
const READ_GATED: Record<Kind, boolean> = { capability: true, restore: true, site: false };

function bodyScroller(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"] .dialog-body-inset');
  if (!el) throw new Error("no dialog body rendered");
  return el;
}

function primary(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-confirm-role="confirm"]');
  if (!el) throw new Error("no primary rendered");
  return el;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function expectStillPending(promise: Promise<unknown>) {
  const sentinel = Symbol("pending");
  const race = Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(sentinel), PENDING_PROBE_MS)),
  ]);
  await advance(PENDING_PROBE_MS);
  expect(await race).toBe(sentinel);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => __resetPluginCapabilityConfirmStoreForTesting());
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

const ADVANCES: Array<[Kind, Kind]> = [
  ["capability", "capability"],
  ["capability", "restore"],
  ["restore", "capability"],
  ["site", "site"],
  ["site", "capability"],
];

describe("PluginCapabilityConfirmDialog — advancing the queue (#16943)", () => {
  it.each(ADVANCES)(
    "starts a %s request's successor (%s) at the top, with focus off the answering button",
    async (firstKind, secondKind) => {
      let first!: Promise<unknown>;
      let second!: Promise<unknown>;
      act(() => {
        first = requestPluginCapabilityConsent(request(firstKind, "first"));
        second = requestPluginCapabilityConsent(request(secondKind, "second"));
      });
      render(<PluginCapabilityConfirmDialog />);
      expect(primary().getAttribute("aria-disabled") === "true").toBe(READ_GATED[firstKind]);
      await advance(PAST_ANY_COOLDOWN_MS);

      const scroller = bodyScroller();
      Object.defineProperty(scroller, "scrollTop", {
        value: 40,
        writable: true,
        configurable: true,
      });
      const allow = screen.getByRole("button", { name: PRIMARY_LABEL[firstKind] });
      act(() => {
        allow.focus();
        fireEvent.click(allow);
      });
      await expect(first).resolves.toBe("approved-and-pin");
      // The scroll reset lands before paint, so it's already in.
      expect(bodyScroller().scrollTop).toBe(0);

      // Focus comes back to the safe answer rather than staying on the primary.
      await advance(16);
      expect(document.activeElement?.getAttribute("data-confirm-role")).toBe("cancel");

      const next = primary();
      expect(next.textContent).toContain(PRIMARY_LABEL[secondKind]);
      if (READ_GATED[secondKind]) {
        // A second click aimed at the last request doesn't answer this one.
        expect(next.getAttribute("aria-disabled")).toBe("true");
        act(() => {
          fireEvent.click(next);
        });
        await expectStillPending(second);
        await advance(PAST_ANY_COOLDOWN_MS);
        expect(document.activeElement?.getAttribute("data-confirm-role")).toBe("cancel");
      }
      expect(primary().hasAttribute("aria-disabled")).toBe(false);
      act(() => {
        fireEvent.click(primary());
      });
      await expect(second).resolves.toBe("approved-and-pin");
    }
  );
});

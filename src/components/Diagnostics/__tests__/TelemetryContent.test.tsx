// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useTelemetryPreviewStore } from "@/store/telemetryPreviewStore";
import type { SanitizedTelemetryEvent } from "@shared/types";
import { TelemetryContent } from "../TelemetryContent";
import { UI_SKELETON_GATE_MS } from "@/lib/animationUtils";
import { act } from "@testing-library/react";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

const TIMESTAMP = Date.UTC(2026, 4, 27, 12, 34, 56, 789);
const ISO = "2026-05-27T12:34:56.789Z";

const EVENT: SanitizedTelemetryEvent = {
  id: "abcd1234-0000-4000-8000-000000000000",
  kind: "analytics",
  timestamp: TIMESTAMP,
  label: "onboarding.completed",
  payload: { step: 3 },
};

function stubPreviewApi() {
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      telemetry: {
        preview: {
          getState: vi.fn().mockResolvedValue({ active: true }),
          toggle: vi.fn(),
          subscribe: vi.fn(),
          unsubscribe: vi.fn(),
          onEventBatch: vi.fn(() => () => {}),
          onStateChanged: vi.fn(() => () => {}),
        },
      },
    },
  });
}

async function renderSelectedEvent() {
  useTelemetryPreviewStore.setState({
    active: true,
    stateRead: "known",
    events: [EVENT],
    selectedEventId: EVENT.id,
  });
  const view = render(<TelemetryContent />);
  const detailTime = view.container.querySelector("time");
  expect(detailTime).not.toBeNull();
  return { ...view, detailTime: detailTime! };
}

describe("TelemetryContent detail header", () => {
  beforeEach(() => {
    stubPreviewApi();
    useTelemetryPreviewStore.getState().reset();
  });

  afterEach(() => {
    // Unmount first: its cleanup still talks to the preview API.
    cleanup();
    useTelemetryPreviewStore.getState().reset();
    Reflect.deleteProperty(window, "electron");
  });

  it("renders the timestamp as a keyboard-reachable time element carrying the exact instant", async () => {
    const { detailTime } = await renderSelectedEvent();

    expect(detailTime.tabIndex).toBe(0);
    expect(detailTime.getAttribute("datetime")).toBe(ISO);
    const local = new Date(TIMESTAMP);
    const pad = (n: number, width = 2) => String(n).padStart(width, "0");
    const clock = `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}.${pad(local.getMilliseconds(), 3)}`;
    expect(detailTime.textContent).toBe(`${local.toLocaleDateString()} ${clock}`);
  });

  it("discloses the exact UTC time in a themed tooltip on focus, not a native title", async () => {
    const { container, detailTime } = await renderSelectedEvent();
    expect(container.querySelector("[title]")).toBeNull();

    fireEvent.focus(detailTime);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe(ISO);
  });

  it("separates the timestamp from the event id with the shared hidden separator, not a raw bullet", async () => {
    const { detailTime } = await renderSelectedEvent();
    const row = detailTime.parentElement!;

    const separator = row.querySelector('[aria-hidden="true"]');
    expect(separator?.textContent).toBeTruthy();
    expect(row.textContent).not.toContain("•");
    expect(row.textContent).toContain("ID abcd1234");
    expect(row.children[0]).toBe(detailTime);
    expect(row.children[1]).toBe(separator);
  });
});

describe("TelemetryContent first-read skeleton onset", () => {
  beforeEach(() => {
    stubPreviewApi();
    useTelemetryPreviewStore.getState().reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useTelemetryPreviewStore.getState().reset();
    Reflect.deleteProperty(window, "electron");
  });

  it("paints no loading rows when the state read settles inside the onset gate", async () => {
    render(<TelemetryContent />);
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UI_SKELETON_GATE_MS - 1);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("paints the loading rows once a slow read crosses the onset gate", async () => {
    const preview = window.electron.telemetry.preview;
    vi.mocked(preview.getState).mockReturnValue(new Promise(() => {}));
    render(<TelemetryContent />);
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UI_SKELETON_GATE_MS);
    });
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Checking telemetry preview"
    );
  });
});

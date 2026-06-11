// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const dispatchMock = vi.fn().mockResolvedValue({ ok: true, result: undefined });
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (payload: unknown) => notifyMock(payload),
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { RosettaBanner } from "../RosettaBanner";
import { useRosettaBannerStore } from "@/store/rosettaBannerStore";

const dismissRosettaWarningMock = vi.fn(() => Promise.resolve());

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  (window as unknown as { electron: unknown }).electron = {
    app: {
      dismissRosettaWarning: dismissRosettaWarningMock,
    },
  };
});

describe("RosettaBanner", () => {
  beforeEach(() => {
    useRosettaBannerStore.setState({ visible: false });
    dispatchMock.mockClear();
    notifyMock.mockClear();
    dismissRosettaWarningMock.mockReset().mockResolvedValue(undefined);
    cleanup();
  });

  it("renders nothing while hidden", () => {
    const { container } = render(<RosettaBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the warning with a download action when visible", () => {
    useRosettaBannerStore.setState({ visible: true });
    render(<RosettaBanner />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Running under Rosetta")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download Apple Silicon build" })).toBeTruthy();
  });

  it("opens the download page via the action service", () => {
    useRosettaBannerStore.setState({ visible: true });
    render(<RosettaBanner />);

    fireEvent.click(screen.getByRole("button", { name: "Download Apple Silicon build" }));

    expect(dispatchMock).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://daintree.org/download" },
      { source: "user" }
    );
  });

  it("hides the banner and persists the dismissal on close", async () => {
    useRosettaBannerStore.setState({ visible: true });
    render(<RosettaBanner />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Rosetta warning" }));

    expect(useRosettaBannerStore.getState().visible).toBe(false);
    await waitFor(() => {
      expect(dismissRosettaWarningMock).toHaveBeenCalledOnce();
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("keeps the banner hidden and surfaces a toast when persisting fails", async () => {
    dismissRosettaWarningMock.mockRejectedValueOnce(new Error("disk full"));
    useRosettaBannerStore.setState({ visible: true });
    render(<RosettaBanner />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Rosetta warning" }));

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalled();
    });
    expect(useRosettaBannerStore.getState().visible).toBe(false);
  });
});

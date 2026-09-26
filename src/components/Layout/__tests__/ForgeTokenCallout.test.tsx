// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useRef } from "react";

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn(),
  },
}));

import { ForgeTokenCallout, type ForgeTokenCalloutProps } from "../ForgeTokenCallout";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import { useForgeTokenCalloutStore } from "@/store/forgeTokenCalloutStore";
import { actionService } from "@/services/ActionService";
import type { ForgeTokenErrorKind } from "@/lib/forgeErrors";

const PROVIDER_ID = "daintree.github.github";

const getCredentialStatus = vi.fn();

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
});

function Harness({
  errorKind,
  onReconnect = () => {},
  onOpenChange,
}: {
  errorKind: ForgeTokenErrorKind | null;
  onReconnect?: () => void;
  onOpenChange?: ForgeTokenCalloutProps["onOpenChange"];
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchorRef} type="button">
        issues pill
      </button>
      <ForgeTokenCallout
        id="callout"
        anchorRef={anchorRef}
        providerId={PROVIDER_ID}
        providerName="GitHub"
        errorKind={errorKind}
        onReconnect={onReconnect}
        onOpenChange={onOpenChange}
      />
    </>
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setTokenHealth(tokenVersion: number, reauthUrl?: string) {
  act(() => {
    useForgeProviderHealthStore.getState().setTokenUnhealthy(PROVIDER_ID, true, {
      status: "unhealthy",
      tokenVersion,
      checkedAt: 0,
      reauthUrl,
    });
  });
}

describe("ForgeTokenCallout", () => {
  beforeEach(() => {
    useForgeProviderHealthStore.setState({ providers: {} });
    useForgeTokenCalloutStore.setState({ dismissed: {} });
    getCredentialStatus.mockReset();
    getCredentialStatus.mockResolvedValue({ hasCredential: true, fingerprint: "fp-1" });
    Object.defineProperty(window, "electron", {
      writable: true,
      configurable: true,
      value: { forge: { getCredentialStatus } },
    });
    vi.mocked(actionService.dispatch).mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("points at the pill when a request failed on an expired token", async () => {
    render(<Harness errorKind="invalid" />);
    await flush();

    expect(screen.getByText("GitHub token expired")).toBeTruthy();
    expect(getCredentialStatus).toHaveBeenCalledWith(PROVIDER_ID);
  });

  it("stays quiet for a token that was never configured", async () => {
    render(<Harness errorKind="not-configured" />);
    await flush();

    expect(screen.queryByTestId("forge-token-callout")).toBeNull();
    expect(getCredentialStatus).not.toHaveBeenCalled();
  });

  it("stays quiet without a token error", async () => {
    render(<Harness errorKind={null} />);
    await flush();

    expect(screen.queryByTestId("forge-token-callout")).toBeNull();
  });

  it("names permission and SSO failures for what they are", async () => {
    const { rerender } = render(<Harness errorKind="permissions" />);
    await flush();
    expect(screen.getByText("GitHub token is missing permissions")).toBeTruthy();

    rerender(<Harness errorKind="sso" />);
    await flush();
    expect(screen.getByText("GitHub token needs SSO authorization")).toBeTruthy();
  });

  it("records the dismissal against the failing credential and stays dismissed on remount", async () => {
    const { unmount } = render(<Harness errorKind="invalid" />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss GitHub token warning" }));

    expect(screen.queryByTestId("forge-token-callout")).toBeNull();
    expect(useForgeTokenCalloutStore.getState().dismissed[PROVIDER_ID]).toBe("fp-1");

    unmount();
    render(<Harness errorKind="invalid" />);
    await flush();
    expect(screen.queryByTestId("forge-token-callout")).toBeNull();
  });

  it("does not re-arm when the health probe flaps under the same credential", async () => {
    render(<Harness errorKind="invalid" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss GitHub token warning" }));

    setTokenHealth(0);
    await flush();

    expect(screen.queryByTestId("forge-token-callout")).toBeNull();
  });

  it("re-arms for a failure after the credential is replaced", async () => {
    render(<Harness errorKind="invalid" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss GitHub token warning" }));

    getCredentialStatus.mockResolvedValue({ hasCredential: true, fingerprint: "fp-2" });
    setTokenHealth(1);
    await flush();

    expect(screen.getByText("GitHub token expired")).toBeTruthy();
  });

  it("dismisses on Escape pressed inside it and hands focus back to the pill", async () => {
    render(<Harness errorKind="invalid" />);
    await flush();

    const close = screen.getByRole("button", { name: "Dismiss GitHub token warning" });
    close.focus();
    fireEvent.keyDown(close, { key: "Escape" });

    expect(screen.queryByTestId("forge-token-callout")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "issues pill" }));
  });

  it("ignores Escape pressed elsewhere in the app", async () => {
    render(<Harness errorKind="invalid" />);
    await flush();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.getByTestId("forge-token-callout")).toBeTruthy();
  });

  it("leaves focus alone when dismissed while focus is elsewhere", async () => {
    render(<Harness errorKind="invalid" />);
    await flush();
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();

    act(() => {
      useForgeTokenCalloutStore.getState().dismiss(PROVIDER_ID, "fp-1");
    });

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("routes Reconnect to the caller and offers the reauthorization page when known", async () => {
    const onReconnect = vi.fn();
    setTokenHealth(0, "https://github.com/orgs/acme/sso");
    render(<Harness errorKind="sso" onReconnect={onReconnect} />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect to GitHub" }));
    expect(onReconnect).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Open reauthorization page" }));
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://github.com/orgs/acme/sso" },
      { source: "user" }
    );
  });

  it("reports its open state so the pill can hold its own tooltip shut", async () => {
    const onOpenChange = vi.fn();
    render(<Harness errorKind="invalid" onOpenChange={onOpenChange} />);
    await flush();

    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss GitHub token warning" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("still offers one dismissal for a credential Daintree does not store", async () => {
    getCredentialStatus.mockResolvedValue({ hasCredential: false });
    render(<Harness errorKind="invalid" />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss GitHub token warning" }));
    expect(useForgeTokenCalloutStore.getState().dismissed[PROVIDER_ID]).toBe("unstored");
  });
});

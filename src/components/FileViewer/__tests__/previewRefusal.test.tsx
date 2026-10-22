// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";
import { mediaElementFailure, previewRefusalOf, useImageErrorHandler } from "../previewRefusal";
import type { MediaPreviewError } from "../useMediaSourceUrl";
import {
  _resetTerminalInputGateForTesting,
  setDriveLeaseSnapshot,
} from "@/services/terminal/inputGate";

const fetchMock = vi.fn();

const lease = (drivingHere: boolean): DriveLeaseView => ({
  projectId: "proj-1",
  holder: {
    leaseId: 3,
    endpointId: "view-9",
    clientId: "shell-b",
    clientName: "greg-mbp",
    isHostLocal: false,
    acquiredAt: 1,
  },
  drivingHere,
  isHolderEndpoint: drivingHere,
  viewerIsHostLocal: false,
});

const answer = (status: number, headers: Record<string, string> = {}) => ({
  ok: status < 300,
  status,
  headers: new Headers(headers),
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  (window as { __DAINTREE_INITIAL_PROJECT__?: { id: string } }).__DAINTREE_INITIAL_PROJECT__ = {
    id: "proj-1",
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  _resetTerminalInputGateForTesting();
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  delete (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__;
});

describe("previewRefusalOf", () => {
  it("reads the reason the host named, and nothing it doesn't know", () => {
    expect(previewRefusalOf(answer(404, { "x-daintree-refusal": "outside-project" }))).toBe(
      "outside-project"
    );
    expect(previewRefusalOf(answer(404, { "x-daintree-refusal": "corrupt" }))).toBeNull();
    expect(previewRefusalOf(answer(404))).toBeNull();
  });

  it("reads an older host's bare 403 as control only while another window drives", () => {
    expect(previewRefusalOf(answer(403))).toBeNull();
    setDriveLeaseSnapshot(lease(true));
    expect(previewRefusalOf(answer(403))).toBeNull();
    setDriveLeaseSnapshot(lease(false));
    expect(previewRefusalOf(answer(403))).toBe("driven-elsewhere");
    expect(previewRefusalOf(answer(500))).toBeNull();
  });
});

function Image({ src, onError }: { src: string; onError: (error?: MediaPreviewError) => void }) {
  const handleError = useImageErrorHandler(src, onError);
  return <img alt="" data-testid="image" src={src} onError={handleError} />;
}

describe("mediaElementFailure", () => {
  it("names control when a remote window's stream stopped while another window drives", () => {
    setDriveLeaseSnapshot(lease(false));
    expect(mediaElementFailure()).toBeUndefined();
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    expect(mediaElementFailure()).toMatchObject({ refusal: "driven-elsewhere" });
    setDriveLeaseSnapshot(lease(true));
    expect(mediaElementFailure()).toBeUndefined();
  });
});

describe("useImageErrorHandler", () => {
  it("reports a failed image at once, unprobed, on this machine", () => {
    const onError = vi.fn();
    const { getByTestId } = render(<Image src="daintree-file://load?path=a" onError={onError} />);
    getByTestId("image").dispatchEvent(new Event("error"));
    expect(onError).toHaveBeenCalledWith();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks a remote window's host why, and drops an answer for a source since replaced", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    let settle!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => (settle = resolve)));
    const onError = vi.fn();
    const { getByTestId, rerender } = render(<Image src="first" onError={onError} />);

    getByTestId("image").dispatchEvent(new Event("error"));
    expect(fetchMock).toHaveBeenCalledWith("first", { method: "HEAD" });
    settle(answer(403, { "x-daintree-refusal": "driven-elsewhere" }));
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ refusal: "driven-elsewhere" }))
    );

    onError.mockClear();
    getByTestId("image").dispatchEvent(new Event("error"));
    rerender(<Image src="second" onError={onError} />);
    settle(answer(403, { "x-daintree-refusal": "driven-elsewhere" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops an answer that arrives after the image is gone", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    let settle!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => (settle = resolve)));
    const onError = vi.fn();
    const { getByTestId, unmount } = render(<Image src="first" onError={onError} />);
    getByTestId("image").dispatchEvent(new Event("error"));
    unmount();
    settle(answer(403, { "x-daintree-refusal": "driven-elsewhere" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).not.toHaveBeenCalled();
  });

  it("names control when control landed here between the failed load and the probe", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    setDriveLeaseSnapshot(lease(false));
    let settle!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => (settle = resolve)));
    const onError = vi.fn();
    const { getByTestId } = render(<Image src="first" onError={onError} />);
    getByTestId("image").dispatchEvent(new Event("error"));
    setDriveLeaseSnapshot(lease(true));
    settle(answer(200));
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ refusal: "driven-elsewhere" }))
    );
  });
});

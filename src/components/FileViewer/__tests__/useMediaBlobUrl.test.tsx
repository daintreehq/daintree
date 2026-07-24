// @vitest-environment jsdom
/**
 * Shared media fetch contract (#11425).
 *
 * `FileVideoPreview` and `FileAudioPreview` both cover the happy path through
 * their own suites. These pin the two invariants neither component test can
 * observe from the outside: that the effect keys on the source alone (so an
 * inline `onError` closure can't restart playback), and that an over-cap
 * declared length releases the protocol stream instead of leaving its fd open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { useMediaBlobUrl, type MediaPreviewError } from "../useMediaBlobUrl";

const fetchMock = vi.fn();

const TOO_LARGE: MediaPreviewError = { title: "Too large", code: "FILE_TOO_LARGE" };

function Probe({ onError, label }: { onError?: (error?: MediaPreviewError) => void; label: string }) {
  const { objectUrl } = useMediaBlobUrl({
    filePath: "/repo/track.mp3",
    rootPath: "/repo",
    maxBytes: 1024,
    tooLargeError: TOO_LARGE,
    onError,
  });
  return <div data-testid="probe" data-url={objectUrl ?? ""} data-label={label} />;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  URL.createObjectURL = vi.fn(() => "blob:app://daintree/0");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("useMediaBlobUrl", () => {
  it("does not refetch when only the error callback identity changes", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: () => Promise.resolve(new Blob(["x"])),
    });

    // A fresh arrow per render is exactly how the three panes pass onError.
    const { rerender, getByTestId } = render(<Probe onError={() => {}} label="first" />);
    await waitFor(() => expect(getByTestId("probe").dataset.url).toMatch(/^blob:/));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(<Probe onError={() => {}} label="second" />);
    rerender(<Probe onError={() => {}} label="third" />);

    // Re-running the effect would abort the fetch and drop the blob, which the
    // user experiences as playback restarting whenever the pane re-renders.
    await waitFor(() => expect(getByTestId("probe").dataset.label).toBe("third"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getByTestId("probe").dataset.url).toMatch(/^blob:/);
  });

  it("cancels the unread body when the declared length exceeds the cap", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const blobSpy = vi.fn(() => Promise.resolve(new Blob(["x"])));
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "4096" }),
      body: { cancel },
      blob: blobSpy,
    });
    const onError = vi.fn();

    render(<Probe onError={onError} label="oversize" />);

    await waitFor(() => expect(onError).toHaveBeenCalledWith(TOO_LARGE));
    // Without the cancel the protocol keeps streaming a file nothing will read.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(blobSpy).not.toHaveBeenCalled();
  });
});

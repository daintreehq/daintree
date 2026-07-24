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

function Probe({
  onError,
  label,
  reloadKey,
}: {
  onError?: (error?: MediaPreviewError) => void;
  label: string;
  reloadKey?: string | number;
}) {
  const { objectUrl, fetching } = useMediaBlobUrl({
    filePath: "/repo/track.mp3",
    rootPath: "/repo",
    reloadKey,
    maxBytes: 1024,
    tooLargeError: TOO_LARGE,
    onError,
  });
  return (
    <div
      data-testid="probe"
      data-url={objectUrl ?? ""}
      data-label={label}
      data-fetching={String(fetching)}
    />
  );
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

  it("reports a non-ok protocol response as a generic failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      blob: () => Promise.resolve(new Blob(["x"])),
    });
    const onError = vi.fn();

    const { getByTestId } = render(<Probe onError={onError} label="missing" />);

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    // Undefined, not the too-large reason — the caller supplies its own copy.
    expect(onError.mock.calls[0]?.[0]).toBeUndefined();
    // The skeleton has to clear, or the pane waits forever on a dead request.
    expect(getByTestId("probe").dataset.fetching).toBe("false");
    expect(getByTestId("probe").dataset.url).toBe("");
  });

  it("reports a blob() rejection rather than hanging on the skeleton", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: () => Promise.reject(new Error("read failed")),
    });
    const onError = vi.fn();

    const { getByTestId } = render(<Probe onError={onError} label="unreadable" />);

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(getByTestId("probe").dataset.fetching).toBe("false");
  });

  it("lets a superseded request neither overwrite nor error over the current one", async () => {
    // The stale-response race: switching files while the first fetch is in
    // flight must not let the old bytes land on the new source.
    const deferred: Array<(value: unknown) => void> = [];
    fetchMock.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          deferred.push(resolve);
          opts.signal.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        })
    );
    const onError = vi.fn();
    const { rerender, getByTestId } = render(
      <Probe onError={onError} label="first" reloadKey={1} />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<Probe onError={onError} label="second" reloadKey={2} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // Settle the SECOND request, then the abandoned first one.
    const secondBlob = new Blob(["new"]);
    deferred[1]?.({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: () => Promise.resolve(secondBlob),
    });
    await waitFor(() => expect(getByTestId("probe").dataset.url).toMatch(/^blob:/));
    const currentUrl = getByTestId("probe").dataset.url;

    deferred[0]?.({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: () => Promise.resolve(new Blob(["stale"])),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getByTestId("probe").dataset.url).toBe(currentUrl);
    expect(onError).not.toHaveBeenCalled();
  });

  it("recovers on a reload after a failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: () => Promise.resolve(new Blob(["x"])),
    });
    const onError = vi.fn();
    const { rerender, getByTestId } = render(
      <Probe onError={onError} label="failed" reloadKey={1} />
    );
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    rerender(<Probe onError={onError} label="retried" reloadKey={2} />);

    // A failed attempt must not latch — the next source gets a clean run.
    await waitFor(() => expect(getByTestId("probe").dataset.url).toMatch(/^blob:/));
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

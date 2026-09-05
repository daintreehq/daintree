// @vitest-environment jsdom
/**
 * Shared media source contract (#11425, #12242).
 *
 * `FileVideoPreview` and `FileAudioPreview` both cover the happy path through
 * their own suites. These pin the invariants neither component test can observe
 * from the outside: that the effect keys on the source alone (so an inline
 * `onError` closure can't restart playback), that the cap is decided by a HEAD
 * which never pulls a body, and that an abandoned probe can't overwrite the
 * source that replaced it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { useMediaSourceUrl, type MediaPreviewError } from "../useMediaSourceUrl";

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
  const { sourceUrl, probing } = useMediaSourceUrl({
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
      data-url={sourceUrl ?? ""}
      data-label={label}
      data-probing={String(probing)}
    />
  );
}

/** A successful size probe under the 1024-byte cap these tests use. */
function headOk(headers: Record<string, string> = { "content-length": "512" }) {
  return { ok: true, status: 200, headers: new Headers(headers) };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("useMediaSourceUrl", () => {
  it("probes with HEAD and resolves the media scheme, never the file scheme", async () => {
    fetchMock.mockResolvedValue(headOk());
    const { getByTestId } = render(<Probe label="first" />);

    await waitFor(() =>
      expect(getByTestId("probe").dataset.url).toBe(
        "daintree-media://load/?path=%2Frepo%2Ftrack.mp3&root=%2Frepo"
      )
    );
    // The cap is measured on daintree-file:// — the one scheme that already
    // carries the fetch/CORS privileges — so the media scheme needs none.
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("daintree-file://load?path=%2Frepo%2Ftrack.mp3&root=%2Frepo");
    expect(init).toMatchObject({ method: "HEAD" });
  });

  it("does not reprobe when only the error callback identity changes", async () => {
    fetchMock.mockResolvedValue(headOk());
    const { rerender, getByTestId } = render(<Probe onError={() => {}} label="first" />);
    await waitFor(() => expect(getByTestId("probe").dataset.url).not.toBe(""));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Callers pass inline closures; re-running the effect would tear down the
    // element and restart playback every time the parent re-renders.
    rerender(<Probe onError={() => {}} label="second" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports an over-cap declared length as the caller's specific error", async () => {
    fetchMock.mockResolvedValue(headOk({ "content-length": "4096" }));
    const onError = vi.fn();
    const { getByTestId } = render(<Probe onError={onError} label="huge" />);

    await waitFor(() => expect(onError).toHaveBeenCalledWith(TOO_LARGE));
    expect(getByTestId("probe").dataset.url).toBe("");
    expect(getByTestId("probe").dataset.probing).toBe("false");
  });

  it("accepts a file exactly at the cap", async () => {
    // The cap is a ceiling, not an exclusive bound — only `>` rejects.
    fetchMock.mockResolvedValue(headOk({ "content-length": "1024" }));
    const onError = vi.fn();
    const { getByTestId } = render(<Probe onError={onError} label="exact" />);

    await waitFor(() => expect(getByTestId("probe").dataset.url).not.toBe(""));
    expect(onError).not.toHaveBeenCalled();
  });

  it("plays a file whose length the probe did not declare", async () => {
    // Nothing is buffered whole any more, so an unmeasurable size costs a few
    // ranges rather than a gigabyte of blob storage. Failing closed here would
    // turn an unrelated header regression into "no media plays at all".
    fetchMock.mockResolvedValue(headOk({}));
    const onError = vi.fn();
    const { getByTestId } = render(<Probe onError={onError} label="unknown" />);

    await waitFor(() => expect(getByTestId("probe").dataset.url).not.toBe(""));
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a non-ok protocol response as a generic failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, headers: new Headers() });
    const onError = vi.fn();
    const { getByTestId } = render(<Probe onError={onError} label="missing" />);

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    // No specific message — callers fall back to their generic copy.
    expect(onError.mock.calls[0]?.[0]).toBeUndefined();
    expect(getByTestId("probe").dataset.url).toBe("");
    expect(getByTestId("probe").dataset.probing).toBe("false");
  });

  it("drops a superseded probe that settles after its request was abandoned", async () => {
    // The stale-response race the guard exists for: a probe that had already
    // settled runs its reaction AFTER cleanup aborted it. Deliberately no abort
    // listener — a rejecting promise would short-circuit to the catch path and
    // never reach the guard on the fulfilled path.
    const deferred: Array<(value: unknown) => void> = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => deferred.push(resolve)));
    const onError = vi.fn();
    const { rerender, getByTestId } = render(
      <Probe onError={onError} label="first" reloadKey={1} />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<Probe onError={onError} label="second" reloadKey={2} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    deferred[1]?.(headOk());
    await waitFor(() => expect(getByTestId("probe").dataset.url).toContain("&v=2"));
    const currentUrl = getByTestId("probe").dataset.url;

    deferred[0]?.(headOk());
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The abandoned probe must not swap the element back to the old source.
    expect(getByTestId("probe").dataset.url).toBe(currentUrl);
    expect(onError).not.toHaveBeenCalled();
  });

  it("carries the cache-busting key onto the media URL, including zero", async () => {
    // Null-checked, not truthiness: `reloadKey={0}` is a real value, and a
    // truthiness test would silently drop it and serve stale bytes.
    fetchMock.mockResolvedValue(headOk());
    const { getByTestId } = render(<Probe label="zero" reloadKey={0} />);

    await waitFor(() => expect(getByTestId("probe").dataset.url).toContain("&v=0"));
  });

  it("recovers on a reload after a failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(headOk());
    const onError = vi.fn();
    const { rerender, getByTestId } = render(
      <Probe onError={onError} label="failed" reloadKey={1} />
    );
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    rerender(<Probe onError={onError} label="retried" reloadKey={2} />);

    // A failed attempt must not latch — the next source gets a clean run.
    await waitFor(() => expect(getByTestId("probe").dataset.url).toContain("&v=2"));
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

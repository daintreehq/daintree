// @vitest-environment jsdom
/**
 * Shared inline PDF preview (#11427).
 *
 * jsdom has no PDFium, so these tests pin the frame contract the real viewer
 * depends on — each assertion here stands in for a failure mode verified
 * against Electron 42 / Chromium 148:
 *   - a missing `credentialless` attribute => ERR_BLOCKED_BY_RESPONSE, blank frame
 *   - a `sandbox` attribute                => ERR_BLOCKED_BY_CLIENT, blank frame
 *   - a daintree-file:// src              => blocked by the app CSP's frame-src
 *
 * The frame mounts only after a HEAD on its URL answers 200 (#12598), so
 * `fetch` is stubbed at that boundary.
 */
import { StrictMode, useLayoutEffect } from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import { FilePdfPreview, type PdfPreviewError } from "../FilePdfPreview";

type ProbeResponse = Pick<Response, "ok" | "status">;

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<ProbeResponse>>();
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  // One global restored rather than `vi.unstubAllGlobals()`, which would also
  // strip what vitest.setup.ts installs for every suite.
  vi.stubGlobal("fetch", realFetch);
});

async function renderPreview(props: Partial<React.ComponentProps<typeof FilePdfPreview>> = {}) {
  const { container } = render(
    <FilePdfPreview filePath="/repo/spec.pdf" rootPath="/repo" label="spec.pdf" {...props} />
  );
  return waitFor(() => {
    const frame = container.querySelector("iframe");
    if (!frame) throw new Error("expected an iframe");
    return frame;
  });
}

function status(code: number): ProbeResponse {
  return { ok: code >= 200 && code < 300, status: code };
}

describe("FilePdfPreview", () => {
  it("points the frame at the PDF-only scheme with the file and root as params", async () => {
    const url = new URL((await renderPreview()).getAttribute("src") ?? "");
    expect(url.protocol).toBe("daintree-pdf:");
    expect(url.searchParams.get("path")).toBe("/repo/spec.pdf");
    expect(url.searchParams.get("root")).toBe("/repo");
  });

  it("marks the frame credentialless so a COEP shell can embed a COEP-less document", async () => {
    // Presence is what matters, and React omits unknown attributes given a
    // boolean value — so assert the attribute actually reached the DOM rather
    // than trusting the prop.
    expect((await renderPreview()).hasAttribute("credentialless")).toBe(true);
  });

  it("never sandboxes the frame", async () => {
    // Unlike the daintree-html:// preview, a sandbox attribute stops PDFium
    // from installing its viewer frame at all.
    expect((await renderPreview()).hasAttribute("sandbox")).toBe(false);
  });

  it("names the frame with the file label and withholds the referrer", async () => {
    const frame = await renderPreview({ label: "datasheet.pdf" });
    expect(frame.getAttribute("title")).toBe("datasheet.pdf");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("re-navigates the same frame to a new URL when the reload key changes", async () => {
    const { container, rerender } = render(
      <FilePdfPreview filePath="/repo/spec.pdf" rootPath="/repo" label="spec.pdf" reloadKey={1} />
    );
    const frame = await waitFor(() => {
      const found = container.querySelector("iframe");
      if (!found) throw new Error("no iframe yet");
      return found;
    });
    const before = frame.getAttribute("src");

    rerender(
      <FilePdfPreview filePath="/repo/spec.pdf" rootPath="/repo" label="spec.pdf" reloadKey={2} />
    );

    await waitFor(() =>
      expect(container.querySelector("iframe")?.getAttribute("src")).not.toBe(before)
    );
    // In place, not remounted: the frame stays up while the new URL is probed.
    expect(container.querySelector("iframe")).toBe(frame);
  });

  it("keeps the same frame and URL when an unrelated prop changes", async () => {
    // The reader's page and zoom live in the frame. A re-render that changed
    // the src — or remounted the element — would silently reset both.
    const { container, rerender } = render(
      <FilePdfPreview filePath="/repo/spec.pdf" rootPath="/repo" label="spec.pdf" reloadKey={7} />
    );
    const frame = await waitFor(() => {
      const found = container.querySelector("iframe");
      if (!found) throw new Error("no iframe yet");
      return found;
    });
    const before = frame.getAttribute("src");

    rerender(
      <FilePdfPreview
        filePath="/repo/spec.pdf"
        rootPath="/repo"
        label="renamed.pdf"
        reloadKey={7}
      />
    );
    await act(async () => {});

    expect(container.querySelector("iframe")).toBe(frame);
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(before);
    // Nor may it re-probe: that would be the first step of a re-navigation.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a zero reload key as a real value rather than an absent one", async () => {
    const zero = (await renderPreview({ reloadKey: 0 })).getAttribute("src");
    cleanup();
    const absent = (await renderPreview()).getAttribute("src");
    expect(zero).not.toBe(absent);
  });

  describe("admission probe (#12598)", () => {
    // An iframe reports no status — its error event never fires, and load
    // fires for an error page too — so the probe is the only thing standing
    // between a 404/413 and an empty box.
    it("HEADs the exact URL the frame will load before mounting it", async () => {
      const frame = await renderPreview({ reloadKey: 3 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [probed, init] = fetchMock.mock.calls[0];
      expect(init?.method).toBe("HEAD");
      expect(probed).toBe(frame.getAttribute("src"));
    });

    it("shows a loading skeleton, not a frame, while the probe is in flight", () => {
      fetchMock.mockReturnValue(new Promise(() => {}));
      const { container } = render(
        <FilePdfPreview filePath="/repo/spec.pdf" rootPath="/repo" label="spec.pdf" />
      );

      expect(container.querySelector("iframe")).toBeNull();
      expect(container.querySelector('[role="status"]')).not.toBeNull();
    });

    it.each<[number, PdfPreviewError["code"]]>([
      [413, "FILE_TOO_LARGE"],
      // A 404 is deliberately ambiguous (missing, or escaped the root), so it
      // must not claim either read-error code; the rest have none to claim.
      [404, undefined],
      [415, undefined],
      [400, undefined],
      [500, undefined],
    ])("reports a %i as a named error and never mounts the frame", async (httpStatus, code) => {
      fetchMock.mockResolvedValue(status(httpStatus));
      const onError = vi.fn();
      const { container } = render(
        <FilePdfPreview
          filePath="/repo/spec.pdf"
          rootPath="/repo"
          label="spec.pdf"
          onError={onError}
        />
      );

      await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      const error: PdfPreviewError = onError.mock.calls[0][0];
      expect(error.code).toBe(code);
      // Both halves, so every caller can render a headline and a way forward.
      expect(error.title).toBeTruthy();
      expect(error.description).toBeTruthy();
      expect(container.querySelector("iframe")).toBeNull();
      expect(container.querySelector('[role="status"]')).toBeNull();
    });

    it("names each refusal distinctly rather than collapsing them into one message", async () => {
      const titles = new Set<string>();
      for (const httpStatus of [404, 413, 415, 500]) {
        fetchMock.mockResolvedValue(status(httpStatus));
        const onError = vi.fn();
        render(
          <FilePdfPreview
            filePath="/repo/spec.pdf"
            rootPath="/repo"
            label="spec.pdf"
            onError={onError}
          />
        );
        await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
        titles.add(onError.mock.calls[0][0].title);
        cleanup();
      }
      expect(titles.size).toBe(4);
    });

    it("reports a probe the network layer refused outright", async () => {
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      const onError = vi.fn();
      const { container } = render(
        <FilePdfPreview
          filePath="/repo/spec.pdf"
          rootPath="/repo"
          label="spec.pdf"
          onError={onError}
        />
      );

      await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(onError.mock.calls[0][0].title).toBeTruthy();
      expect(container.querySelector("iframe")).toBeNull();
    });

    it("drops a failure that settles after the file changed", async () => {
      // The first file's probe fails late; by then the preview shows another
      // file, and flagging an error then would blame the wrong document.
      let failFirst: (response: ProbeResponse) => void = () => {};
      fetchMock.mockReturnValueOnce(
        new Promise((resolve) => {
          failFirst = resolve;
        })
      );
      const onError = vi.fn();
      const { container, rerender } = render(
        <FilePdfPreview filePath="/repo/a.pdf" rootPath="/repo" label="a.pdf" onError={onError} />
      );
      rerender(
        <FilePdfPreview filePath="/repo/b.pdf" rootPath="/repo" label="b.pdf" onError={onError} />
      );
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());

      await act(async () => failFirst(status(404)));

      expect(onError).not.toHaveBeenCalled();
      const src = new URL(container.querySelector("iframe")?.getAttribute("src") ?? "");
      expect(src.searchParams.get("path")).toBe("/repo/b.pdf");
    });

    it("never commits the previous document's frame under the next one's props", async () => {
      // RTL's rerender flushes passive effects, which is where the probe
      // resets — so read the DOM from a layout effect instead, which runs on
      // the very commit that first renders the new file, before that reset.
      const committedPaths: Array<string | null> = [];
      function CommitProbe() {
        useLayoutEffect(() => {
          const src = document.querySelector("iframe")?.getAttribute("src");
          committedPaths.push(src ? new URL(src).searchParams.get("path") : null);
        });
        return null;
      }
      const { container, rerender } = render(
        <>
          <FilePdfPreview filePath="/repo/a.pdf" rootPath="/repo" label="a.pdf" />
          <CommitProbe />
        </>
      );
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());

      fetchMock.mockReturnValue(new Promise(() => {}));
      committedPaths.length = 0;
      rerender(
        <>
          <FilePdfPreview filePath="/repo/b.pdf" rootPath="/repo" label="b.pdf" />
          <CommitProbe />
        </>
      );

      expect(committedPaths).not.toContain("/repo/a.pdf");
      expect(container.querySelector("iframe")).toBeNull();
      expect(container.querySelector('[role="status"]')).not.toBeNull();
    });

    it("drops a success that settles after the file changed", async () => {
      let admitFirst: (response: ProbeResponse) => void = () => {};
      fetchMock.mockReturnValueOnce(
        new Promise((resolve) => {
          admitFirst = resolve;
        })
      );
      fetchMock.mockReturnValueOnce(new Promise(() => {}));
      const { container, rerender } = render(
        <FilePdfPreview filePath="/repo/a.pdf" rootPath="/repo" label="a.pdf" />
      );
      rerender(<FilePdfPreview filePath="/repo/b.pdf" rootPath="/repo" label="b.pdf" />);

      await act(async () => admitFirst(status(200)));

      expect(container.querySelector("iframe")).toBeNull();
    });

    it("treats a new root for the same path as a different document", async () => {
      const { container, rerender } = render(
        <FilePdfPreview filePath="/repo/spec.pdf" rootPath="/repo" label="spec.pdf" />
      );
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());

      fetchMock.mockReturnValue(new Promise(() => {}));
      rerender(<FilePdfPreview filePath="/repo/spec.pdf" rootPath="/" label="spec.pdf" />);

      expect(container.querySelector("iframe")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("settles into one frame under StrictMode's double effect", async () => {
      const onError = vi.fn();
      const { container } = render(
        <StrictMode>
          <FilePdfPreview
            filePath="/repo/spec.pdf"
            rootPath="/repo"
            label="spec.pdf"
            onError={onError}
          />
        </StrictMode>
      );

      await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(1));
      // The first mount's probe is aborted by its own cleanup, never reported.
      expect(onError).not.toHaveBeenCalled();
    });

    it("never shows the previous document while a different one is probed", async () => {
      const { container, rerender } = render(
        <FilePdfPreview filePath="/repo/a.pdf" rootPath="/repo" label="a.pdf" />
      );
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());

      fetchMock.mockReturnValue(new Promise(() => {}));
      rerender(<FilePdfPreview filePath="/repo/b.pdf" rootPath="/repo" label="b.pdf" />);

      expect(container.querySelector("iframe")).toBeNull();
    });

    it("drops the frame when a refresh of the same document fails", async () => {
      const onError = vi.fn();
      const { container, rerender } = render(
        <FilePdfPreview
          filePath="/repo/spec.pdf"
          rootPath="/repo"
          label="spec.pdf"
          reloadKey={1}
          onError={onError}
        />
      );
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());

      fetchMock.mockResolvedValue(status(404));
      rerender(
        <FilePdfPreview
          filePath="/repo/spec.pdf"
          rootPath="/repo"
          label="spec.pdf"
          reloadKey={2}
          onError={onError}
        />
      );

      await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(container.querySelector("iframe")).toBeNull();
    });
  });
});

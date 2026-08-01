// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const dispatchMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
// Source mode mounts CodeMirror, which has nothing to do with what these cover.
vi.mock("@/components/FileViewer/CodeViewer", () => ({
  CodeViewer: () => <div data-testid="code-viewer-mock" />,
}));

import { MarkdownViewer } from "../MarkdownViewer";

const FIXTURE_PROPS = {
  content: "# Spec title",
  filePath: "/repo/docs/spec.md",
  rootPath: "/repo",
};

describe("MarkdownViewer", () => {
  // #11255: hosts that size to their content pin their height across the swap
  // into rendered mode and release it on this signal. If the forwarding breaks,
  // the pin is never handed back.
  it("reports the rendered document's commit to its host", async () => {
    const onRendered = vi.fn();
    render(<MarkdownViewer {...FIXTURE_PROPS} viewMode="rendered" onRendered={onRendered} />);

    // The document is lazy — nothing to report while the chunk is in flight.
    expect(onRendered).not.toHaveBeenCalled();

    await screen.findByRole("heading", { level: 1 });
    // The heading commits before the callback runs: onRendered fires from a
    // passive effect, which React schedules after the commit that findByRole's
    // observer wakes on. Polling closes that window without loosening the
    // exactly-once claim — a second call keeps this failing.
    await waitFor(() => expect(onRendered).toHaveBeenCalledTimes(1));
  });

  // #11587: the token has to survive the lazy() boundary. The document itself is
  // covered in MarkdownDocument.test.tsx; what this pins is the forwarding, which
  // could be deleted with every document-level test still green.
  it("forwards the cache token across the lazy boundary to local images", async () => {
    render(
      <MarkdownViewer
        {...FIXTURE_PROPS}
        content={"![diagram](./img/arch.png)"}
        viewMode="rendered"
        cacheBust="rev-7"
      />
    );

    const img = await screen.findByRole("img", { name: "diagram" });
    expect(new URL(img.getAttribute("src") ?? "").searchParams.get("v")).toBe("rev-7");
  });

  it("stays silent in source mode, which has no chunk to wait on", () => {
    const onRendered = vi.fn();
    render(<MarkdownViewer {...FIXTURE_PROPS} viewMode="source" onRendered={onRendered} />);

    expect(screen.getByTestId("code-viewer-mock")).toBeDefined();
    expect(onRendered).not.toHaveBeenCalled();
  });
});

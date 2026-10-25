// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanopyStatusBar, formatLinkMs, formatModelBytes } from "../CanopyStatusBar";

const READER = { model: "Light", inFlight: 2, readMs: 24 };
const READY = { id: "daintreehq/canopy-reader-17m", status: "ready" as const };

function bar(container: HTMLElement) {
  return container.querySelector<HTMLElement>("[data-canopy-status]")!;
}

describe("CanopyStatusBar", () => {
  it("says which model reads, on this computer, and how long a screen takes", () => {
    const { container } = render(
      <CanopyStatusBar reader={READER} model={READY} waiting={undefined} />
    );
    expect(bar(container).textContent).toBe("Light model, on this computer24 ms a screen");
    expect(container.querySelector("[data-working]")?.getAttribute("data-working")).toBe("true");
  });

  it("names the host that reads, when the panel shows another one", () => {
    const { container } = render(
      <CanopyStatusBar host="studio-01" reader={READER} model={READY} waiting={undefined} />
    );
    expect(bar(container).textContent).toContain("Light model, on studio-01");
    expect(bar(container).textContent).not.toContain("this computer");
  });

  it("goes quiet once every screen is read, and leaves out a time it has none of", () => {
    const { container } = render(
      <CanopyStatusBar
        reader={{ ...READER, inFlight: 0, readMs: null }}
        model={READY}
        waiting={undefined}
      />
    );
    expect(bar(container).textContent).toBe("Light model, on this computer");
    expect(container.querySelector("[data-working]")?.getAttribute("data-working")).toBe("false");
  });

  it("puts the download in the readings' place, and announces only that", () => {
    const downloading = {
      id: READY.id,
      status: "downloading" as const,
      received: 8_200_000,
      total: 20_900_000,
    };
    const { container, rerender } = render(
      <CanopyStatusBar reader={READER} model={downloading} waiting={undefined} />
    );
    const said = "Downloading the model… 8.2 MB of 21 MB";
    expect(bar(container).textContent).toContain(said);
    expect(bar(container).textContent).not.toContain("a screen");
    expect(container.querySelector("[role=status]")?.textContent).toBe(said);
    // Read out by the status line alone, not once more as the bar's text.
    const shown = [...bar(container).querySelectorAll("span")].find(
      (span) => span.textContent === said && span.role !== "status"
    );
    expect(shown?.getAttribute("aria-hidden")).toBe("true");
    rerender(<CanopyStatusBar reader={READER} model={READY} waiting={undefined} />);
    expect(container.querySelector("[role=status]")?.textContent).toBe("");
  });

  it("offers to retry a failed download where it failed, and says a retry still to come", () => {
    const retry = vi.fn();
    const { container, rerender, getByRole } = render(
      <CanopyStatusBar
        host="studio-01"
        onRetryModel={retry}
        reader={READER}
        model={{ id: READY.id, status: "failed", error: "HTTP 503" }}
        waiting={undefined}
      />
    );
    expect(bar(container).textContent).toContain("Couldn't download the model");
    expect(bar(container).textContent).not.toContain("HTTP");
    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<CanopyStatusBar reader={READER} model={READY} waiting="retrying" />);
    expect(bar(container).textContent).toContain("Waiting to retry…");
  });

  it("keeps its row while there is nothing to say yet", () => {
    const { container } = render(
      <CanopyStatusBar reader={undefined} model={undefined} waiting={undefined} />
    );
    expect(bar(container)).not.toBeNull();
    expect(bar(container).textContent).toBe("");
  });

  it("writes times under a second in milliseconds and longer ones in tenths", () => {
    expect([
      formatLinkMs(48),
      formatLinkMs(999),
      formatLinkMs(1_000),
      formatLinkMs(12_345),
    ]).toEqual(["48 ms", "999 ms", "1.0 s", "12.3 s"]);
  });

  it("writes sizes to a tenth of a megabyte under ten, and whole ones above", () => {
    expect([
      formatModelBytes(368),
      formatModelBytes(3_583_228),
      formatModelBytes(69_749_457),
    ]).toEqual(["0.0 MB", "3.6 MB", "70 MB"]);
  });
});

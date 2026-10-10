// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CanopyStatusBar, formatLinkMs } from "../CanopyStatusBar";

const LINK = { host: "canopy.daintree.org", inFlight: 2, classifyMs: 420, readMs: 2_140 };

function bar(container: HTMLElement) {
  return container.querySelector<HTMLElement>("[data-canopy-status]")!;
}

describe("CanopyStatusBar", () => {
  it("says where the requests go, how many are out, and how long they take", () => {
    const { container } = render(<CanopyStatusBar link={LINK} waiting={undefined} />);
    expect(bar(container).textContent).toBe(
      "canopy.daintree.org2 in flight · classify 420 ms · summary 2.1 s"
    );
    expect(container.querySelector("[data-working]")?.getAttribute("data-working")).toBe("true");
  });

  it("goes quiet once every request is back, and leaves out times it has none of", () => {
    const { container } = render(
      <CanopyStatusBar link={{ ...LINK, inFlight: 0, readMs: null }} waiting={undefined} />
    );
    expect(bar(container).textContent).toBe("canopy.daintree.org0 in flight · classify 420 ms");
    expect(container.querySelector("[data-working]")?.getAttribute("data-working")).toBe("false");
  });

  it("puts a hold-up in the readings' place, and announces only that", () => {
    const { container, rerender } = render(<CanopyStatusBar link={LINK} waiting="waking" />);
    expect(bar(container).textContent).toContain("Starting Canopy's service…");
    expect(bar(container).textContent).not.toContain("in flight");
    expect(container.querySelector("[role=status]")?.textContent).toBe(
      "Starting Canopy's service…"
    );
    // Read out by the status line alone, not once more as the bar's text.
    const shown = [...bar(container).querySelectorAll("span")].find(
      (span) => span.textContent === "Starting Canopy's service…" && span.role !== "status"
    );
    expect(shown?.getAttribute("aria-hidden")).toBe("true");
    rerender(<CanopyStatusBar link={LINK} waiting={undefined} />);
    expect(container.querySelector("[role=status]")?.textContent).toBe("");
  });

  it("keeps its row while there is nothing to say yet", () => {
    const { container } = render(<CanopyStatusBar link={undefined} waiting={undefined} />);
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
});

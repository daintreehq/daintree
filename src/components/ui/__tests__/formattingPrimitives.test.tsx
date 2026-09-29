// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DiffStat } from "../DiffStat";
import { ProgressBar } from "../ProgressBar";
import { TimeAgo } from "../TimeAgo";

describe("DiffStat", () => {
  it("renders added then removed, space-separated, with no separator glyph", () => {
    const { container } = render(<DiffStat insertions={12} deletions={3} />);
    const parts = Array.from(container.firstElementChild!.children).map((el) => el.textContent);
    expect(parts).toEqual(["+12", "-3"]);
    expect(container.textContent).not.toMatch(/[/−]/);
  });

  it("colours the sides with the success and error inks", () => {
    const { container } = render(<DiffStat insertions={1} deletions={1} />);
    const [added, removed] = Array.from(container.firstElementChild!.children);
    expect(added!.className).toContain("text-status-success");
    expect(removed!.className).toContain("text-status-error");
  });

  it("drops a zero side, and the whole stat when both are zero", () => {
    expect(render(<DiffStat insertions={4} deletions={0} />).container.textContent).toBe("+4");
    expect(render(<DiffStat insertions={0} deletions={2} />).container.textContent).toBe("-2");
    expect(render(<DiffStat insertions={0} deletions={0} />).container.innerHTML).toBe("");
    expect(render(<DiffStat />).container.innerHTML).toBe("");
  });
});

describe("ProgressBar", () => {
  it("reports a clamped value on the determinate bar", () => {
    const { getByRole } = render(<ProgressBar label="Download" value={140} />);
    const bar = getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.getAttribute("aria-label")).toBe("Download");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("100%");
  });

  it("drops aria-valuenow and the fill while indeterminate", () => {
    const { getByRole } = render(<ProgressBar label="Connecting" value={null} />);
    const bar = getByRole("progressbar");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.firstElementChild).toBeNull();
  });

  it("draws every size on the same track and fill", () => {
    const { getByLabelText } = render(
      <>
        <ProgressBar label="a" value={1} max={4} />
        <ProgressBar label="b" value={1} max={4} size="thin" />
      </>
    );
    const a = getByLabelText("a");
    const b = getByLabelText("b");
    const track = (el: HTMLElement) => el.className.split(/\s+/).filter((c) => c.startsWith("bg-"));
    expect(track(a)).toEqual(track(b));
    expect((a.firstElementChild as HTMLElement).className).toBe(
      (b.firstElementChild as HTMLElement).className
    );
  });
});

describe("TimeAgo", () => {
  const NOW = Date.parse("2026-09-29T12:00:00Z");

  it("always carries the exact time as a machine value and a hover title", () => {
    const ts = NOW - 5 * 60_000;
    const { container } = render(<TimeAgo timestamp={ts} now={NOW} />);
    const time = container.querySelector("time")!;
    expect(time.getAttribute("dateTime")).toBe(new Date(ts).toISOString());
    expect(time.getAttribute("title")).toBe(new Date(ts).toLocaleString());
  });

  it("keeps a prefix inside the label", () => {
    const { container } = render(
      <TimeAgo timestamp={NOW - 5 * 60_000} now={NOW} prefix="Last checked " />
    );
    expect(container.querySelector("time")!.textContent).toMatch(/^Last checked /);
  });

  it("renders an invalid timestamp without throwing or claiming an exact time", () => {
    const { container } = render(<TimeAgo timestamp="not-a-date" now={NOW} />);
    const time = container.querySelector("time")!;
    expect(time.hasAttribute("title")).toBe(false);
    expect(time.textContent).toBe("Unknown");
  });
});

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CommitInfoTooltip } from "../CommitInfoTooltip";

const human = { name: "Jane Doe", email: "jane@example.com" };

describe("CommitInfoTooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z").getTime());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the author, commit time, and message", () => {
    render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now() - 120_000}
        author={human}
        commitMessage="fix: resolve the navigation race"
      />
    );
    expect(screen.getByText("Jane Doe")).toBeDefined();
    expect(screen.getByText("Committed 2 minutes ago")).toBeDefined();
    expect(screen.getByText("fix: resolve the navigation race")).toBeDefined();
  });

  it("renders a Gravatar image with the d=404 probe for a human author", () => {
    const { container } = render(
      <CommitInfoTooltip lastCommitTimestampMs={Date.now()} author={human} />
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toContain("gravatar.com");
    expect(img!.getAttribute("src")).toContain("d=404");
  });

  it("falls through to coloured initials when Gravatar 404s", () => {
    const { container } = render(
      <CommitInfoTooltip lastCommitTimestampMs={Date.now()} author={human} />
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("JD")).toBeDefined();
  });

  it("renders a branded agent icon for an agent committer", () => {
    const { container } = render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now()}
        author={{ name: "Codex", email: "noreply@codex.openai.com" }}
      />
    );
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders a square avatar for a bot author", () => {
    const { container } = render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now()}
        author={{
          name: "dependabot[bot]",
          email: "49699333+dependabot[bot]@users.noreply.github.com",
        }}
      />
    );
    const img = container.querySelector("img")!;
    expect(img.className).toContain("rounded-md");
    expect(img.className).not.toContain("rounded-full");
  });

  it("shows a generic header and no avatar when the author is absent", () => {
    const { container } = render(<CommitInfoTooltip lastCommitTimestampMs={Date.now() - 60_000} />);
    expect(screen.getByText("Last commit")).toBeDefined();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders the Last active line only when an activity timestamp is given", () => {
    const { rerender } = render(
      <CommitInfoTooltip lastCommitTimestampMs={Date.now() - 600_000} author={human} />
    );
    expect(screen.queryByText(/Last active/)).toBeNull();

    rerender(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now() - 600_000}
        author={human}
        lastActivityTimestamp={Date.now() - 120_000}
      />
    );
    expect(screen.getByText("Last active 2 minutes ago")).toBeDefined();
  });

  it("renders activity detail when the repository has no commit", () => {
    const { container } = render(
      <CommitInfoTooltip lastActivityTimestamp={Date.now() - 120_000} />
    );

    expect(screen.getByText("Last active 2 minutes ago")).toBeDefined();
    expect(screen.queryByText("Last commit")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("keeps commit detail when activity comes from a later file change", () => {
    render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Date.now() - 3_600_000}
        author={human}
        commitMessage="fix: preserve commit context"
        lastActivityTimestamp={Date.now() - 120_000}
      />
    );

    expect(screen.getByText("Jane Doe")).toBeDefined();
    expect(screen.getByText("Committed 1 hour ago")).toBeDefined();
    expect(screen.getByText("fix: preserve commit context")).toBeDefined();
    expect(screen.getByText("Last active 2 minutes ago")).toBeDefined();
  });

  it("does not repeat activity detail when the commit is the activity source", () => {
    const timestamp = Date.now() - 120_000;
    render(
      <CommitInfoTooltip
        lastCommitTimestampMs={timestamp}
        author={human}
        lastActivityTimestamp={timestamp}
      />
    );

    expect(screen.getByText("Committed 2 minutes ago")).toBeDefined();
    expect(screen.queryByText(/Last active/)).toBeNull();
  });

  it("renders nothing when both timestamps are invalid", () => {
    const { container } = render(
      <CommitInfoTooltip
        lastCommitTimestampMs={Number.NaN}
        lastActivityTimestamp={Date.now() + 1}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});

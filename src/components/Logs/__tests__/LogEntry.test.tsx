// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LogEntry } from "../LogEntry";

const renderRow = (ui: ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);
import type { LogEntry as LogEntryType } from "@/types";

const entry: LogEntryType = {
  id: "l1",
  timestamp: Date.now(),
  level: "error",
  source: "git",
  message: "git fetch failed",
  context: { exitCode: 128 },
};

describe("LogEntry", () => {
  it("keeps Copy outside the row's disclosure so neither triggers the other", () => {
    const onToggle = vi.fn();
    renderRow(<LogEntry entry={entry} count={3} isExpanded={false} onToggle={onToggle} />);
    const disclosure = screen.getByRole("button", { expanded: false });
    const copy = screen.getByRole("button", { name: "Copy log entry" });

    expect(disclosure.contains(copy)).toBe(false);
    fireEvent.click(copy);
    fireEvent.keyDown(copy, { key: "Enter" });
    expect(onToggle).not.toHaveBeenCalled();

    fireEvent.click(disclosure);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("names the disclosure with what a reader scans the row for", () => {
    renderRow(<LogEntry entry={entry} count={3} isExpanded={false} onToggle={vi.fn()} />);
    const name = screen.getByRole("button", { expanded: false }).getAttribute("aria-label") ?? "";
    expect(name).toContain("ERROR");
    expect(name).toContain("git");
    expect(name).toContain(entry.message);
    expect(name).toContain("3");
  });

  it("renders no disclosure for an entry without context", () => {
    renderRow(
      <LogEntry entry={{ ...entry, context: undefined }} isExpanded={false} onToggle={vi.fn()} />
    );
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy log entry" })).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
  source: "pty-host",
  message: "git fetch failed",
  context: { exitCode: 128 },
};

describe("LogEntry", () => {
  it("keeps Copy outside the row's disclosure so each does only its own job", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onToggle = vi.fn();
    renderRow(<LogEntry entry={entry} count={3} isExpanded={false} onToggle={onToggle} />);
    const disclosure = screen.getByRole("button", { expanded: false });
    const copy = screen.getByRole("button", { name: "Copy log entry" });

    expect(disclosure.contains(copy)).toBe(false);

    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(onToggle).not.toHaveBeenCalled();

    fireEvent.click(disclosure);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("names the disclosure with what a reader scans the row for", () => {
    renderRow(<LogEntry entry={entry} count={3} isExpanded={false} onToggle={vi.fn()} />);
    const name = screen.getByRole("button", { expanded: false }).getAttribute("aria-label") ?? "";
    expect(name).toContain("ERROR");
    expect(name).toContain("pty-host");
    expect(name).toContain(entry.message);
    expect(name).toMatch(/repeated 3 times/);
  });

  it("renders no disclosure for an entry without context", () => {
    renderRow(
      <LogEntry entry={{ ...entry, context: undefined }} isExpanded={false} onToggle={vi.fn()} />
    );
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy log entry" })).toBeTruthy();
  });
});

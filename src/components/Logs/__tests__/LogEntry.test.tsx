// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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

  describe("a collapsed group whose members carry different contexts", () => {
    const first: LogEntryType = {
      id: "g1",
      timestamp: Date.UTC(2026, 0, 1, 10, 0, 0),
      level: "info",
      source: "ipc",
      message: "request handled",
      context: { requestId: "a" },
    };
    const second: LogEntryType = {
      ...first,
      id: "g2",
      timestamp: Date.UTC(2026, 0, 1, 10, 0, 5),
      context: { requestId: "b" },
    };

    it("shows every member's context when expanded", () => {
      renderRow(
        <LogEntry
          entry={first}
          members={[first, second]}
          count={2}
          isExpanded={true}
          onToggle={vi.fn()}
        />
      );
      const region = screen.getByRole("region", { name: /context/i });
      expect(region.textContent).toContain('"requestId": "a"');
      expect(region.textContent).toContain('"requestId": "b"');
    });

    it("copies every member's context", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      renderRow(
        <LogEntry
          entry={first}
          members={[first, second]}
          count={2}
          isExpanded={false}
          onToggle={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Copy log entry" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const payload = String(writeText.mock.calls[0]?.[0]);
      expect(payload).toContain('"requestId": "a"');
      expect(payload).toContain('"requestId": "b"');
      expect(payload).toContain(new Date(second.timestamp).toISOString());
    });

    it("offers the disclosure when only a later member has context", () => {
      const bare = { ...first, context: undefined };
      renderRow(
        <LogEntry
          entry={bare}
          members={[bare, second]}
          count={2}
          isExpanded={true}
          onToggle={vi.fn()}
        />
      );
      expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
      expect(screen.getByRole("region", { name: /context/i }).textContent).toContain(
        '"requestId": "b"'
      );
    });

    it("lists distinct contexts in first-seen order with their repeats", () => {
      const repeatOfFirst = { ...first, id: "g3", timestamp: first.timestamp + 9000 };
      const bare = { ...first, id: "g4", timestamp: first.timestamp + 12000, context: {} };
      renderRow(
        <LogEntry
          entry={first}
          members={[first, second, repeatOfFirst, bare]}
          count={4}
          isExpanded={true}
          onToggle={vi.fn()}
        />
      );
      const items = within(screen.getByRole("region", { name: /context/i })).getAllByRole(
        "listitem"
      );
      expect(items.map((item) => item.textContent)).toEqual([
        expect.stringMatching(/repeated 2 times.*"requestId": "a"/s),
        expect.not.stringMatching(/repeated/),
        expect.stringContaining("No context"),
      ]);
      expect(items[1]?.textContent).toContain('"requestId": "b"');
    });

    it("shows a shared context once", () => {
      const twin = { ...second, context: { requestId: "a" } };
      renderRow(
        <LogEntry
          entry={first}
          members={[first, twin]}
          count={2}
          isExpanded={true}
          onToggle={vi.fn()}
        />
      );
      const region = screen.getByRole("region", { name: /context/i });
      expect(region.textContent?.split('"requestId": "a"')).toHaveLength(2);
    });
  });

  it("renders no disclosure for an entry without context", () => {
    renderRow(
      <LogEntry entry={{ ...entry, context: undefined }} isExpanded={false} onToggle={vi.fn()} />
    );
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy log entry" })).toBeTruthy();
  });
});

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

    // b first, so a sort by request ID can't pass for first-seen order.
    const burst: LogEntryType[] = [
      { ...second, id: "h1", timestamp: first.timestamp },
      { ...first, id: "h2", timestamp: first.timestamp + 5000 },
      { ...first, id: "h3", timestamp: first.timestamp + 9000 },
      { ...first, id: "h4", timestamp: first.timestamp + 12000, context: {} },
    ];
    const iso = (ms: number) => new Date(ms).toISOString();

    const copyPayload = async (members: LogEntryType[]) => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      renderRow(
        <LogEntry
          entry={members[0]!}
          members={members}
          count={members.length}
          isExpanded={false}
          onToggle={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Copy log entry" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      return String(writeText.mock.calls[0]?.[0]);
    };

    it("copies each distinct context once, in first-seen order, with its repeats", async () => {
      const payload = await copyPayload(burst);
      const b = payload.indexOf('"requestId": "b"');
      const aHeading = payload.indexOf(`[${iso(burst[1]!.timestamp)}] (2 times)`);
      const a = payload.indexOf('"requestId": "a"');
      const none = payload.indexOf("(no context)");
      expect(payload).toContain("(repeated 4 times)");
      expect(payload).toContain(`[${iso(burst[0]!.timestamp)}]\n`);
      expect(b).toBeGreaterThan(-1);
      expect(aHeading).toBeGreaterThan(b);
      expect(a).toBeGreaterThan(aHeading);
      expect(none).toBeGreaterThan(a);
      expect(payload.split('"requestId": "a"')).toHaveLength(2);
      expect(payload.split('"requestId": "b"')).toHaveLength(2);
      expect(payload.split("(no context)")).toHaveLength(2);
      expect(payload).not.toContain(iso(burst[2]!.timestamp));
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

    it("lists distinct contexts in first-seen order with when each first appeared", () => {
      renderRow(
        <LogEntry
          entry={burst[0]!}
          members={burst}
          count={burst.length}
          isExpanded={true}
          onToggle={vi.fn()}
        />
      );
      const items = within(screen.getByRole("region", { name: /context/i })).getAllByRole(
        "listitem"
      );
      expect(items).toHaveLength(3);
      expect(items[0]?.textContent).toContain('"requestId": "b"');
      expect(items[0]?.textContent).not.toMatch(/repeated|×/);
      expect(items[1]?.textContent).toContain('"requestId": "a"');
      expect(items[1]?.textContent).toContain("×2");
      expect(items[1]?.textContent).toContain("repeated 2 times");
      const time = items[1]?.querySelector("time");
      expect(time?.getAttribute("datetime")).toBe(iso(burst[1]!.timestamp));
      expect(time?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      expect(items[2]?.textContent).toContain("No context");
    });

    it("shows and copies a shared context once, without a list", async () => {
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
      expect(within(region).queryAllByRole("listitem")).toHaveLength(0);
      expect(region.textContent?.split('"requestId": "a"')).toHaveLength(2);

      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      fireEvent.click(screen.getByRole("button", { name: "Copy log entry" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const payload = String(writeText.mock.calls[0]?.[0]);
      expect(payload.split('"requestId": "a"')).toHaveLength(2);
      expect(payload).not.toContain(iso(twin.timestamp));
      expect(payload).not.toContain(`[${iso(first.timestamp)}]\n`);
    });
  });

  it("renders no disclosure for a context whose every field is undefined", () => {
    // An error logged without details arrives as `{ error: undefined }`.
    renderRow(
      <LogEntry
        entry={{ ...entry, context: { error: undefined } }}
        isExpanded={false}
        onToggle={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
  });

  it("renders no disclosure for an entry without context", () => {
    renderRow(
      <LogEntry entry={{ ...entry, context: undefined }} isExpanded={false} onToggle={vi.fn()} />
    );
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy log entry" })).toBeTruthy();
  });
});

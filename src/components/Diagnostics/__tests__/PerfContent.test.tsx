// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rtlRender, screen, act, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@/clients/filesClient", () => ({
  filesClient: {
    read: vi.fn(),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

import { filesClient } from "@/clients/filesClient";
import { ClientAppError } from "@/utils/clientAppError";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resetPerfMetricsForTests, usePerfMetricsStore } from "@/store/perfMetricsStore";
import { useProjectStore } from "@/store/projectStore";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { PerfContent } from "../PerfContent";

const mockRead = vi.mocked(filesClient.read);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

const REFRESH_NAME = "Re-read benchmark results";
const LONG_NAME = "Spawn forty terminals while the worktree dashboard is rebuilding its index";
const LONG_NOTES = "Outside reference because the harness ran with the GPU compositor disabled";

interface Aggregate {
  id: string;
  name: string;
  outsideReference?: boolean;
  referenceNotes?: string;
}

function summaryJson(generatedAt: string, aggregates: Aggregate[]) {
  return JSON.stringify({
    generatedAt,
    mode: "smoke",
    aggregates: aggregates.map((a) => ({
      id: a.id,
      name: a.name,
      p95Ms: 12.5,
      outsideReference: a.outsideReference ?? false,
      referenceNotes: a.referenceNotes,
    })),
  });
}

// Only the smoke file exists, which is the shape of a project that has run
// one benchmark mode.
function serveSmoke(generatedAt: string, aggregates: Aggregate[]) {
  mockRead.mockImplementation(async ({ path }: { path: string }) => {
    if (path.endsWith("latest-smoke.summary.json")) {
      return { content: summaryJson(generatedAt, aggregates) };
    }
    throw new ClientAppError("NOT_FOUND", "file missing");
  });
}

function deferred() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function selectProject() {
  useProjectStore.setState({
    currentProject: { id: "p1", name: "App", path: "/work/app", emoji: "", lastOpened: 0 },
  });
}

const refreshButton = () => screen.getByRole("button", { name: REFRESH_NAME });
const spinning = (button: HTMLElement) => button.querySelector("[data-spinning]") !== null;
const heading = () => document.getElementById("perf-results")!.textContent ?? "";

describe("PerfContent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    mockRead.mockReset();
    resetPerfMetricsForTests();
    selectProject();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    resetPerfMetricsForTests();
    useProjectStore.setState({ currentProject: null });
  });

  describe("results heading", () => {
    it("counts a single scenario in the singular", async () => {
      serveSmoke("2026-05-27T11:55:00.000Z", [{ id: "boot", name: "Boot" }]);
      render(<PerfContent />);
      await flush();

      expect(heading()).toContain("1 scenario");
      expect(heading()).not.toContain("1 scenarios");
    });

    it("pluralizes several scenarios and names how many sit outside reference", async () => {
      serveSmoke("2026-05-27T11:55:00.000Z", [
        { id: "boot", name: "Boot", outsideReference: true },
        { id: "render", name: "Render" },
        { id: "scroll", name: "Scroll" },
      ]);
      render(<PerfContent />);
      await flush();

      expect(heading()).toContain("3 scenarios, 1 outside reference");
    });
  });

  describe("benchmark age", () => {
    it("renders the generation time as a relative age with the exact time attached", async () => {
      const generatedAt = "2026-05-27T11:55:00.000Z";
      serveSmoke(generatedAt, [{ id: "boot", name: "Boot" }]);
      const { container } = render(<PerfContent />);
      await flush();

      const age = container.querySelector("time")!;
      expect(age.textContent).toBe("Generated 5m ago");
      expect(age.getAttribute("datetime")).toBe(generatedAt);
      expect(age.getAttribute("title")).toBe(new Date(generatedAt).toLocaleString());
    });

    it("never falls back to a numeric locale date for an old run", async () => {
      serveSmoke("2026-05-24T12:00:00.000Z", [{ id: "boot", name: "Boot" }]);
      const { container } = render(<PerfContent />);
      await flush();

      expect(container.querySelector("time")!.textContent).toBe("Generated 3d ago");
    });

    it("names a month, never a numeric date, once a run is more than 30 days old", async () => {
      serveSmoke("2026-04-01T12:00:00.000Z", [{ id: "boot", name: "Boot" }]);
      const { container } = render(<PerfContent />);
      await flush();

      const text = container.querySelector("time")!.textContent!;
      const month = new Intl.DateTimeFormat(undefined, { month: "short" }).format(
        new Date("2026-04-01T12:00:00.000Z")
      );
      expect(text).toContain(month);
      expect(text).not.toContain("ago");
      expect(text).not.toMatch(/\d+[/.-]\d+/);
    });

    it("moves the age forward on the shared minute clock", async () => {
      serveSmoke("2026-05-27T11:58:30.000Z", [{ id: "boot", name: "Boot" }]);
      const { container } = render(<PerfContent />);
      await flush();
      expect(container.querySelector("time")!.textContent).toBe("Generated 1m ago");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(container.querySelector("time")!.textContent).toBe("Generated 6m ago");
    });
  });

  describe("refresh button", () => {
    async function mountLoaded() {
      serveSmoke("2026-05-27T11:55:00.000Z", [{ id: "boot", name: "Boot" }]);
      render(<PerfContent />);
      await flush();
      return refreshButton();
    }

    it("stays focusable, undimmed and spinning through a manual read, and ignores presses in flight", async () => {
      const button = await mountLoaded();
      const readsBefore = mockRead.mock.calls.length;
      const { gate, release } = deferred();
      mockRead.mockImplementation(async ({ path }: { path: string }) => {
        await gate;
        if (path.endsWith("latest-smoke.summary.json")) {
          return {
            content: summaryJson("2026-05-27T11:55:00.000Z", [{ id: "boot", name: "Boot" }]),
          };
        }
        throw new ClientAppError("NOT_FOUND", "file missing");
      });

      button.focus();
      fireEvent.click(button);

      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(document.activeElement).toBe(button);
      expect(spinning(button)).toBe(true);

      const readsInFlight = mockRead.mock.calls.length;
      expect(readsInFlight).toBeGreaterThan(readsBefore);
      fireEvent.click(button);
      fireEvent.click(button);
      expect(mockRead.mock.calls.length).toBe(readsInFlight);

      release();
      await flush();

      expect(button.getAttribute("aria-disabled")).toBeNull();
      expect(refreshButton()).toBe(button);
      expect(document.activeElement).toBe(button);
    });

    it("does not spin for a read that settles inside the Doherty gate, and spins once it outlasts it", async () => {
      const { gate, release } = deferred();
      mockRead.mockImplementation(async () => {
        await gate;
        throw new ClientAppError("NOT_FOUND", "file missing");
      });
      render(<PerfContent />);
      await flush();

      const button = refreshButton();
      expect(button.getAttribute("aria-disabled")).toBe("true");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(UI_DOHERTY_THRESHOLD - 50);
      });
      expect(spinning(button)).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(spinning(button)).toBe(true);

      release();
      await flush();
      expect(button.getAttribute("aria-disabled")).toBeNull();
    });

    it("does not spin when the read settles before the gate opens", async () => {
      serveSmoke("2026-05-27T11:55:00.000Z", [{ id: "boot", name: "Boot" }]);
      render(<PerfContent />);
      await flush();
      const button = refreshButton();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(UI_DOHERTY_THRESHOLD * 2);
      });
      expect(spinning(button)).toBe(false);
    });

    it("does not carry a finished manual press over to the next read of the same project", async () => {
      const button = await mountLoaded();
      fireEvent.click(button);
      await flush();
      // Past the spinner's own finishing turn.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(button.getAttribute("aria-disabled")).toBeNull();

      const { gate, release } = deferred();
      mockRead.mockImplementation(async () => {
        await gate;
        throw new ClientAppError("NOT_FOUND", "file missing");
      });
      // A read the user did not ask for, on the project the press was for.
      act(() => {
        void usePerfMetricsStore.getState().refreshSummaries("/work/app");
      });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(UI_DOHERTY_THRESHOLD - 50);
      });
      expect(spinning(button)).toBe(false);

      release();
      await flush();
    });
  });

  describe("clipped cells", () => {
    let scrollWidth: ReturnType<typeof vi.spyOn>;
    let clientWidth: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // jsdom has no layout: a cell holding the long strings overflows its box.
      scrollWidth = vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (
        this: Element
      ) {
        const text = this.textContent ?? "";
        return text === LONG_NAME || text === LONG_NOTES ? 400 : 40;
      });
      clientWidth = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(100);
    });

    afterEach(() => {
      cleanup();
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
    });

    it("makes a clipped scenario name keyboard reachable and discloses the full text", async () => {
      serveSmoke("2026-05-27T11:55:00.000Z", [
        { id: "long", name: LONG_NAME },
        { id: "short", name: "Boot" },
      ]);
      render(<PerfContent />);
      await flush();

      const clipped = screen.getByText(LONG_NAME);
      expect(clipped.tabIndex).toBe(0);
      expect(screen.getByText("Boot").hasAttribute("tabindex")).toBe(false);

      fireEvent.focus(clipped);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(screen.getAllByText(LONG_NAME).length).toBeGreaterThan(1);
    });

    it("discloses clipped notes, and leaves an empty notes cell alone", async () => {
      serveSmoke("2026-05-27T11:55:00.000Z", [
        { id: "long", name: "Long", referenceNotes: LONG_NOTES },
        { id: "none", name: "None" },
      ]);
      const { container } = render(<PerfContent />);
      await flush();

      const clipped = screen.getByText(LONG_NOTES);
      expect(clipped.tabIndex).toBe(0);

      const stops = container.querySelectorAll("td [tabindex]");
      expect(stops.length).toBe(1);

      fireEvent.focus(clipped);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(screen.getAllByText(LONG_NOTES).length).toBeGreaterThan(1);
    });
  });
});

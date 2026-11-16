// @vitest-environment jsdom
// Its own file so its module cache starts cold: the commit list's chunk loads on
// the commits pill's hover, focus or open and no sooner (#17034).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => {
  let release: () => void = () => {};
  const chunk = new Promise<void>((resolve) => (release = resolve));
  return { chunk, release: () => release(), imported: vi.fn(), failNext: false };
});

// The boundary's reporting side channels, not anything under test here.
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/utils/rendererSentry", () => ({
  captureRendererException: vi.fn(),
  getRendererSentryConsent: vi.fn(() => ({ level: "off", hasSeenPrompt: false })),
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

// Held back until the test lets the chunk land; `failNext` rejects one import.
vi.mock("../LocalCommitsDropdown", async () => {
  h.imported();
  if (h.failNext) {
    h.failNext = false;
    throw new Error("chunk 404");
  }
  await h.chunk;
  return {
    LocalCommitsDropdown: ({ cwd }: { cwd: string }) => <div data-testid="commit-list">{cwd}</div>,
  };
});

const { LazyLocalCommitsDropdown, preloadLocalCommitsDropdown } =
  await import("../LazyLocalCommitsDropdown");

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  cleanup();
});

describe("local commits dropdown, cold (#17034)", () => {
  it("holds the panel's box while loading, reports a failed load, and retries it", async () => {
    // A warm-up that fails is swallowed: the open is what reports it.
    h.failNext = true;
    preloadLocalCommitsDropdown();
    await flush();
    expect(h.imported).toHaveBeenCalledTimes(1);

    h.failNext = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <LazyLocalCommitsDropdown cwd="/repo" open initialCount={3} onClose={() => {}} />
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await flush();
    expect(h.imported).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();

    // Try again remounts the loader, which issues the import again.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    });
    expect(h.imported).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    await act(async () => {
      h.release();
    });
    await flush();
    expect(screen.getByTestId("commit-list").textContent).toBe("/repo");
  });
});

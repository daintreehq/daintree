// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { LastDictationTerms } from "@shared/types";
import { LastDictationTermsSection } from "../LastDictationTerms";

const snapshot = (over: Partial<LastDictationTerms> = {}): LastDictationTerms => ({
  sessionId: "s1",
  provider: "deepgram",
  assembledCount: 4,
  startedAt: 1,
  keytermAttempt: "full",
  sent: [
    { term: "Daintree", source: "project" },
    { term: "zod", source: "dictionary" },
    { term: "mySecretTerm", source: "dictionary" },
    { term: "feature", source: "branch" },
  ],
  ...over,
});

function mockApi(getLastTerms: () => Promise<LastDictationTerms | null>) {
  const statusListeners: Array<() => void> = [];
  const unsubscribeStatus = vi.fn();
  const unsubscribeEnded = vi.fn();
  window.electron = {
    voiceInput: {
      getLastTerms: vi.fn(getLastTerms),
      onStatus: vi.fn((cb: () => void) => {
        statusListeners.push(cb);
        return unsubscribeStatus;
      }),
      onSessionEnded: vi.fn(() => unsubscribeEnded),
    },
  } as unknown as typeof window.electron;
  return { statusListeners, unsubscribeStatus, unsubscribeEnded };
}

describe("LastDictationTermsSection", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("explains the empty state before any dictation", async () => {
    mockApi(async () => null);
    render(<LastDictationTermsSection />);
    expect(await screen.findByText(/Dictate once/)).toBeTruthy();
  });

  it("shows per-source counts and reveals the terms on demand", async () => {
    mockApi(async () => snapshot());
    render(<LastDictationTermsSection />);
    expect(await screen.findByText("Sent to Deepgram")).toBeTruthy();
    expect(screen.getByText("4 of 4 terms sent")).toBeTruthy();
    // Each count sits right after its label in the row.
    expect(document.body.textContent).toContain(
      "Your dictionary2Project dictionary0Project name1Repository names0Branch name1Terminal output0"
    );
    expect(screen.queryByText(/mySecretTerm/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show terms" }));
    expect(screen.getByText("zod, mySecretTerm")).toBeTruthy();
  });

  it("names a spoken rewrite instruction as what sent the terms", async () => {
    mockApi(async () => snapshot({ provider: "openai", rewrite: true }));
    render(<LastDictationTermsSection />);
    expect(await screen.findByText("Rewrite instruction sent to OpenAI")).toBeTruthy();
    expect(screen.queryByText("Sent to OpenAI")).toBeNull();
  });

  it("says when a Deepgram retry dropped terms", async () => {
    mockApi(async () => snapshot({ assembledCount: 30, keytermAttempt: "trimmed" }));
    render(<LastDictationTermsSection />);
    expect(await screen.findByText(/retried with fewer terms/)).toBeTruthy();
  });

  it("shows a retry that sent no terms as sent, not pending", async () => {
    mockApi(async () => snapshot({ sent: [], keytermAttempt: "none" }));
    render(<LastDictationTermsSection />);
    expect(await screen.findByText(/0 of 4 terms sent/)).toBeTruthy();
    expect(screen.getByText(/retried with none/)).toBeTruthy();
    expect(screen.queryByText("Waiting for the connection to open")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show terms" })).toBeNull();
  });

  it("says when a session closed before the provider sent any terms", async () => {
    mockApi(async () => snapshot({ provider: "openai", sent: [], endedBeforeSending: true }));
    render(<LastDictationTermsSection />);
    expect(
      await screen.findByText("The connection closed before any terms were sent")
    ).toBeTruthy();
    expect(screen.queryByText(/dropped by/)).toBeNull();
    expect(screen.queryByText(/0 of 4 terms sent/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show terms" })).toBeNull();
  });

  it("blames the provider's limits only for a request that went out", async () => {
    mockApi(async () => snapshot({ provider: "openai", assembledCount: 6 }));
    render(<LastDictationTermsSection />);
    expect(
      await screen.findByText("4 of 6 terms sent. 2 terms dropped by OpenAI's limits.")
    ).toBeTruthy();
  });

  it("separates not-yet-reported from none sent", async () => {
    mockApi(async () => snapshot({ sent: null }));
    render(<LastDictationTermsSection />);
    expect(await screen.findByText("Waiting for the connection to open")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show terms" })).toBeNull();
  });

  it("keeps the newest reply when an older fetch resolves last", async () => {
    const pending: Array<(v: LastDictationTerms | null) => void> = [];
    const { statusListeners } = mockApi(() => new Promise((resolve) => pending.push(resolve)));
    render(<LastDictationTermsSection />);
    await act(async () => statusListeners[0]!());
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]!(snapshot({ provider: "openai", assembledCount: 9 })));
    await act(async () => pending[0]!(snapshot({ provider: "deepgram", assembledCount: 1 })));
    expect(screen.getByText("Sent to OpenAI")).toBeTruthy();
    expect(screen.queryByText("Sent to Deepgram")).toBeNull();
  });

  it("stops listening when it unmounts", async () => {
    const { unsubscribeStatus, unsubscribeEnded } = mockApi(async () => null);
    const view = render(<LastDictationTermsSection />);
    await screen.findByText(/Dictate once/);
    view.unmount();
    expect(unsubscribeStatus).toHaveBeenCalledTimes(1);
    expect(unsubscribeEnded).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when loading fails", async () => {
    mockApi(async () => {
      throw new Error("nope");
    });
    render(<LastDictationTermsSection />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

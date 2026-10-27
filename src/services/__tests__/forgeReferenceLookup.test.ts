// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeNumberReference, ForgeReferenceLookupResult } from "@shared/types/forge";

const getReferencesByNumbers =
  vi.fn<(cwd: string, numbers: number[]) => Promise<ForgeReferenceLookupResult[] | null>>();

vi.mock("@/clients", () => ({
  forgeClient: {
    getReferencesByNumbers: (cwd: string, numbers: number[]) =>
      getReferencesByNumbers(cwd, numbers),
  },
}));

import {
  invalidateForgeReferences,
  knownForgeReferences,
  lookUpForgeReferences,
  onForgeReferencesInvalidated,
} from "../forgeReferenceLookup";

const CWD = "/repo";
const issue = (number: number): ForgeNumberReference => ({
  kind: "issue",
  number,
  title: `Issue ${number}`,
  state: "open",
});

/** Main's answer: every number in `found` is an issue, the rest name nothing. */
function answerWith(found: number[]) {
  return async (_cwd: string, numbers: number[]): Promise<ForgeReferenceLookupResult[]> =>
    numbers.map((number) =>
      found.includes(number)
        ? { number, status: "found", reference: issue(number) }
        : { number, status: "not_found" }
    );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  invalidateForgeReferences();
  getReferencesByNumbers.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("forge reference lookup (#14849)", () => {
  it("knows what was found and asks about each number once while it's fresh", async () => {
    getReferencesByNumbers.mockImplementation(answerWith([7]));
    await lookUpForgeReferences(CWD, [7, 99]);
    expect(knownForgeReferences(CWD, [7, 99])).toEqual(new Map([[7, issue(7)]]));

    await lookUpForgeReferences(CWD, [7, 99]);
    expect(getReferencesByNumbers).toHaveBeenCalledTimes(1);
  });

  it("asks again once an answer goes stale, sooner for a number that named nothing", async () => {
    getReferencesByNumbers.mockImplementation(answerWith([7]));
    await lookUpForgeReferences(CWD, [7, 99]);

    vi.advanceTimersByTime(61_000);
    await lookUpForgeReferences(CWD, [7, 99]);
    expect(getReferencesByNumbers.mock.calls[1]![1]).toEqual([99]);

    vi.advanceTimersByTime(300_000);
    await lookUpForgeReferences(CWD, [7, 99]);
    expect(getReferencesByNumbers.mock.calls[2]![1]).toEqual([7, 99]);
  });

  it("keeps a known reference through a lookup that got no answer, and waits to retry", async () => {
    getReferencesByNumbers.mockImplementation(answerWith([7]));
    await lookUpForgeReferences(CWD, [7]);
    vi.advanceTimersByTime(301_000);

    getReferencesByNumbers.mockRejectedValueOnce(new Error("Rate limit exceeded"));
    await lookUpForgeReferences(CWD, [7]);
    expect(knownForgeReferences(CWD, [7]).get(7)).toEqual(issue(7));

    await lookUpForgeReferences(CWD, [7]);
    expect(getReferencesByNumbers).toHaveBeenCalledTimes(2);
  });

  it("asks nothing and knows nothing for a while once main says lookups are unavailable", async () => {
    getReferencesByNumbers.mockImplementation(answerWith([7]));
    await lookUpForgeReferences(CWD, [7]);
    vi.advanceTimersByTime(301_000);

    getReferencesByNumbers.mockResolvedValueOnce(null);
    await lookUpForgeReferences(CWD, [7]);
    expect(knownForgeReferences(CWD, [7]).size).toBe(0);
    await lookUpForgeReferences(CWD, [8]);
    expect(getReferencesByNumbers).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(31_000);
    await lookUpForgeReferences(CWD, [8]);
    expect(getReferencesByNumbers).toHaveBeenCalledTimes(3);
  });

  it("forgets what it found once lookups become unavailable, and tells the composers", async () => {
    getReferencesByNumbers.mockImplementation(answerWith([7]));
    await lookUpForgeReferences(CWD, [7]);
    await lookUpForgeReferences("/other", [7]);
    const listener = vi.fn();
    const stop = onForgeReferencesInvalidated(listener);

    getReferencesByNumbers.mockResolvedValueOnce(null);
    await lookUpForgeReferences(CWD, [8]);
    expect(listener).toHaveBeenCalledTimes(1);

    // Past the unavailable window, the old answer is not trusted back.
    vi.advanceTimersByTime(31_000);
    expect(knownForgeReferences(CWD, [7]).size).toBe(0);
    expect(knownForgeReferences("/other", [7]).get(7)).toEqual(issue(7));
    await lookUpForgeReferences(CWD, [7]);
    expect(getReferencesByNumbers.mock.calls.at(-1)).toEqual([CWD, [7]]);
    stop();
  });

  it("keeps one request in flight per repository and sends what came up meanwhile next", async () => {
    const first = deferred<ForgeReferenceLookupResult[]>();
    getReferencesByNumbers
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(answerWith([1, 2, 3]));

    const a = lookUpForgeReferences(CWD, [1]);
    const b = lookUpForgeReferences(CWD, [1, 2]);
    const c = lookUpForgeReferences(CWD, [3]);
    await Promise.resolve();
    expect(getReferencesByNumbers).toHaveBeenCalledTimes(1);

    first.resolve([{ number: 1, status: "found", reference: issue(1) }]);
    await Promise.all([a, b, c]);
    expect(getReferencesByNumbers.mock.calls.map((call) => call[1])).toEqual([[1], [2, 3]]);
    expect([...knownForgeReferences(CWD, [1, 2, 3]).keys()]).toEqual([1, 2, 3]);
  });

  it("splits a long draft into requests main will answer", async () => {
    getReferencesByNumbers.mockImplementation(answerWith([]));
    const numbers = Array.from({ length: 120 }, (_, i) => i + 1);
    await lookUpForgeReferences(CWD, numbers);
    expect(getReferencesByNumbers.mock.calls.map((call) => call[1].length)).toEqual([50, 50, 20]);
  });

  it("keeps repositories apart", async () => {
    getReferencesByNumbers.mockImplementation(answerWith([7]));
    await lookUpForgeReferences(CWD, [7]);
    expect(knownForgeReferences("/other", [7]).size).toBe(0);
  });

  it("drops what a lookup in flight learns once everything is invalidated, and says so", async () => {
    const pending = deferred<ForgeReferenceLookupResult[]>();
    getReferencesByNumbers.mockImplementationOnce(() => pending.promise);
    const listener = vi.fn();
    const stop = onForgeReferencesInvalidated(listener);

    const lookup = lookUpForgeReferences(CWD, [7]);
    await Promise.resolve();
    invalidateForgeReferences();
    expect(listener).toHaveBeenCalledTimes(1);

    pending.resolve([{ number: 7, status: "found", reference: issue(7) }]);
    await lookup;
    expect(knownForgeReferences(CWD, [7]).size).toBe(0);
    stop();
  });

  it("re-reads after a sidebar refresh", async () => {
    getReferencesByNumbers.mockImplementation(answerWith([7]));
    await lookUpForgeReferences(CWD, [7]);
    window.dispatchEvent(new Event("daintree:refresh-sidebar"));
    expect(knownForgeReferences(CWD, [7]).size).toBe(0);
    await lookUpForgeReferences(CWD, [7]);
    expect(getReferencesByNumbers).toHaveBeenCalledTimes(2);
  });
});

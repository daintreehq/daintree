/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useInputReceiptKey } from "../useInputReceiptKey";

type Props = { pinged: string | null; seq: number; ids: string[] };

describe("useInputReceiptKey", () => {
  it("does not increment on initial mount even when seq > 0 and id matches", () => {
    // Mount snapshots the current seq into the ref; only subsequent advances
    // count as pings. This avoids flashing every card when a card mounts mid
    // session with a stale (but still-live) `pingedId`.
    const { result } = renderHook(() => useInputReceiptKey("t-1", 5, ["t-1"]));
    expect(result.current).toBe(0);
  });

  it("increments when seq advances and pingedId matches a card terminal", () => {
    const { result, rerender } = renderHook(
      ({ pinged, seq, ids }: Props) => useInputReceiptKey(pinged, seq, ids),
      { initialProps: { pinged: null, seq: 0, ids: ["t-1", "t-2"] } as Props }
    );
    expect(result.current).toBe(0);

    rerender({ pinged: "t-1", seq: 1, ids: ["t-1", "t-2"] });
    expect(result.current).toBe(1);
  });

  it("does not increment when seq advances but pingedId belongs to another card", () => {
    const { result, rerender } = renderHook(
      ({ pinged, seq, ids }: Props) => useInputReceiptKey(pinged, seq, ids),
      { initialProps: { pinged: null, seq: 0, ids: ["t-1"] } as Props }
    );
    rerender({ pinged: "other-terminal", seq: 1, ids: ["t-1"] });
    expect(result.current).toBe(0);
  });

  it("does not increment on the 1.6s null clear (seq does not advance)", () => {
    const { result, rerender } = renderHook(
      ({ pinged, seq, ids }: Props) => useInputReceiptKey(pinged, seq, ids),
      { initialProps: { pinged: null, seq: 0, ids: ["t-1"] } as Props }
    );

    rerender({ pinged: "t-1", seq: 1, ids: ["t-1"] });
    expect(result.current).toBe(1);

    // The 1.6s clear in `pingTerminal` does NOT advance `pingSeq` — the
    // clearing path is `set({ pingedId: null })` only.
    rerender({ pinged: null, seq: 1, ids: ["t-1"] });
    expect(result.current).toBe(1);
  });

  it("re-keys on back-to-back pings of the SAME terminal (the gap fix)", () => {
    // Without the seq counter, `pingTerminal` calling `set({ pingedId: id })`
    // twice with the same id would be `Object.is`-equal and emit no update,
    // dropping the second receipt.
    const { result, rerender } = renderHook(
      ({ pinged, seq, ids }: Props) => useInputReceiptKey(pinged, seq, ids),
      { initialProps: { pinged: null, seq: 0, ids: ["t-1"] } as Props }
    );

    rerender({ pinged: "t-1", seq: 1, ids: ["t-1"] });
    expect(result.current).toBe(1);

    rerender({ pinged: "t-1", seq: 2, ids: ["t-1"] });
    expect(result.current).toBe(2);
  });

  it("does not re-fire when terminalIds change but seq is unchanged", () => {
    const { result, rerender } = renderHook(
      ({ pinged, seq, ids }: Props) => useInputReceiptKey(pinged, seq, ids),
      { initialProps: { pinged: null, seq: 0, ids: ["t-1"] } as Props }
    );

    rerender({ pinged: "t-1", seq: 1, ids: ["t-1"] });
    expect(result.current).toBe(1);

    // Terminal added; same ping still live. The receipt must NOT double-flash
    // for one logical input event.
    rerender({ pinged: "t-1", seq: 1, ids: ["t-1", "t-2"] });
    expect(result.current).toBe(1);
  });

  it("does not increment when terminalIds is empty even on a seq advance", () => {
    const { result, rerender } = renderHook(
      ({ pinged, seq, ids }: Props) => useInputReceiptKey(pinged, seq, ids),
      { initialProps: { pinged: null, seq: 0, ids: [] } as Props }
    );

    rerender({ pinged: "t-1", seq: 1, ids: [] });
    expect(result.current).toBe(0);
  });

  it("fires when an already-live ping's target terminal joins this card mid-flight", () => {
    // Race scenario: a ping fires before the card sees the terminal in its
    // membership list. The seq is still the latest, and the terminal is now a
    // member, but seq hasn't advanced — so the receipt does NOT fire on the
    // late join. This is intentional: we acknowledge inputs at their moment,
    // not after-the-fact when the structural state catches up.
    const { result, rerender } = renderHook(
      ({ pinged, seq, ids }: Props) => useInputReceiptKey(pinged, seq, ids),
      { initialProps: { pinged: "t-1", seq: 1, ids: [] } as Props }
    );
    expect(result.current).toBe(0);

    rerender({ pinged: "t-1", seq: 1, ids: ["t-1"] });
    expect(result.current).toBe(0);

    // A NEW ping (seq advances) on the now-known terminal does fire.
    rerender({ pinged: "t-1", seq: 2, ids: ["t-1"] });
    expect(result.current).toBe(1);
  });
});

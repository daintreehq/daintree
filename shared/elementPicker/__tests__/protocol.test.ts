import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ELEMENT_PICKER_PROTOCOL_VERSION,
  MAX_ELEMENT_PICKER_MESSAGE_BYTES,
  SELECTION_LIMITS,
  admitElementPickerMessage,
  type ElementPickerAdmission,
  type ElementPickerEvent,
} from "../index.js";
import { component, hover, selection } from "./fixtures.js";

const admission: ElementPickerAdmission = Object.freeze({
  sessionId: "session-1",
  documentEpoch: 2,
  lastSequence: 4,
});

const ready: ElementPickerEvent = {
  type: "documentReady",
  url: "http://localhost:5173/pricing",
  viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
};

function envelope(event: unknown = ready, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: ELEMENT_PICKER_PROTOCOL_VERSION,
    sessionId: "session-1",
    documentEpoch: 2,
    sequence: 5,
    event,
    ...overrides,
  };
}

const send = (event?: unknown, overrides?: Record<string, unknown>) =>
  JSON.stringify(envelope(event, overrides));

const utf8 = (text: string) => new TextEncoder().encode(text).length;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admitElementPickerMessage", () => {
  it("admits a current message and advances only the returned state", () => {
    const verdict = admitElementPickerMessage(send(), admission);
    expect(verdict).toMatchObject({ ok: true, admission: { ...admission, lastSequence: 5 } });
    expect(admission.lastSequence).toBe(4);
  });

  describe("malformed", () => {
    it.each([
      ["a non-string", { protocolVersion: 1 }],
      ["undefined", undefined],
      ["invalid JSON", "{"],
      ["a JSON null", "null"],
      ["a JSON scalar", "42"],
      ["a JSON array", "[]"],
    ])("rejects %s", (_, raw) => {
      expect(admitElementPickerMessage(raw, admission)).toEqual({ ok: false, reason: "malformed" });
    });

    it("rejects a missing envelope field and an extra one", () => {
      const { sequence: _sequence, ...noSequence } = envelope();
      expect(admitElementPickerMessage(JSON.stringify(noSequence), admission)).toEqual({
        ok: false,
        reason: "malformed",
      });
      expect(admitElementPickerMessage(send(ready, { origin: "page" }), admission)).toEqual({
        ok: false,
        reason: "malformed",
      });
    });

    it("rejects an unknown event and an unknown key deep inside a known one", () => {
      expect(admitElementPickerMessage(send({ type: "evalScript", code: "1" }), admission).ok).toBe(
        false
      );
      const nested = {
        type: "hoverChanged",
        observation: { ...hover(), bounds: [{ x: 0, y: 0, width: 1, height: 1, z: 1 }] },
      };
      expect(admitElementPickerMessage(send(nested), admission)).toEqual({
        ok: false,
        reason: "malformed",
      });
    });

    it("rejects observations on the wrong side of the hover/selection line", () => {
      const hoverWithSelection = { type: "hoverChanged", observation: selection() };
      const selectionWithHover = {
        type: "selectionChanged",
        observations: [hover()],
        cause: "user",
        scope: { kind: "element" },
      };
      const hoverWithContext = {
        type: "hoverChanged",
        observation: { ...hover(), context: { selector: "a", markup: "", styles: [] } },
      };
      for (const event of [hoverWithSelection, selectionWithHover, hoverWithContext]) {
        expect(admitElementPickerMessage(send(event), admission)).toEqual({
          ok: false,
          reason: "malformed",
        });
      }
    });

    it("rejects a selection that repeats an element or scopes to a component it does not contain", () => {
      const base = { type: "selectionChanged", cause: "user", scope: { kind: "element" } };
      expect(
        admitElementPickerMessage(
          send({ ...base, observations: [selection(), selection()] }),
          admission
        ).ok
      ).toBe(false);
      const card = selection({
        componentChain: { nearestId: "card", components: [component("card")], truncated: false },
      });
      expect(
        admitElementPickerMessage(
          send({
            ...base,
            observations: [card],
            scope: { kind: "component", componentId: "card" },
          }),
          admission
        ).ok
      ).toBe(true);
      expect(
        admitElementPickerMessage(
          send({
            ...base,
            observations: [card],
            scope: { kind: "component", componentId: "ghost" },
          }),
          admission
        ).ok
      ).toBe(false);
      const tooMany = Array.from({ length: SELECTION_LIMITS.observations + 1 }, (_, i) =>
        selection({ elementId: `el-${i}` })
      );
      expect(
        admitElementPickerMessage(send({ ...base, observations: tooMany }), admission).ok
      ).toBe(false);
    });
  });

  it("names a protocol version mismatch separately from a malformed body", () => {
    expect(
      admitElementPickerMessage(
        send(ready, { protocolVersion: ELEMENT_PICKER_PROTOCOL_VERSION + 1 }),
        admission
      )
    ).toEqual({ ok: false, reason: "protocol-version" });
  });

  it("rejects another binding's session", () => {
    expect(admitElementPickerMessage(send(ready, { sessionId: "session-2" }), admission)).toEqual({
      ok: false,
      reason: "unknown-session",
    });
  });

  describe("stale", () => {
    it.each([1, 3])("rejects epoch %i against a current epoch of 2", (documentEpoch) => {
      expect(admitElementPickerMessage(send(ready, { documentEpoch }), admission)).toEqual({
        ok: false,
        reason: "stale-epoch",
      });
    });

    it.each([4, 0])("rejects sequence %i once 4 has been admitted", (sequence) => {
      expect(admitElementPickerMessage(send(ready, { sequence }), admission)).toEqual({
        ok: false,
        reason: "replayed-sequence",
      });
    });

    it("lets a sequence skip ahead", () => {
      expect(admitElementPickerMessage(send(ready, { sequence: 90 }), admission).ok).toBe(true);
    });

    it("starts a replaced document at sequence zero and refuses the old one's traffic", () => {
      const next: ElementPickerAdmission = {
        sessionId: "session-1",
        documentEpoch: 3,
        lastSequence: -1,
      };
      expect(
        admitElementPickerMessage(send(ready, { documentEpoch: 3, sequence: 0 }), next).ok
      ).toBe(true);
      expect(
        admitElementPickerMessage(send(ready, { documentEpoch: 2, sequence: 99 }), next)
      ).toEqual({
        ok: false,
        reason: "stale-epoch",
      });
    });
  });

  describe("oversized", () => {
    const padTo = (raw: string, bytes: number) => raw + " ".repeat(bytes - utf8(raw));

    it("admits a message at the ceiling and rejects one byte past it", () => {
      const atCeiling = padTo(send(), MAX_ELEMENT_PICKER_MESSAGE_BYTES);
      expect(utf8(atCeiling)).toBe(MAX_ELEMENT_PICKER_MESSAGE_BYTES);
      expect(admitElementPickerMessage(atCeiling, admission).ok).toBe(true);
      expect(admitElementPickerMessage(`${atCeiling} `, admission)).toEqual({
        ok: false,
        reason: "oversized",
      });
    });

    it("counts UTF-8 bytes, not string length", () => {
      // Each "€" is one UTF-16 code unit and three UTF-8 bytes, inside fields that are each within bounds.
      const wide = Array.from({ length: SELECTION_LIMITS.observations }, (_, i) =>
        selection({
          elementId: `el-${i}`,
          context: { selector: "p", markup: "€".repeat(2048), styles: [] },
        })
      );
      const body = send({
        type: "selectionChanged",
        observations: wide,
        cause: "user",
        scope: { kind: "element" },
      });
      expect(admitElementPickerMessage(body, admission).ok).toBe(true);

      const raw = body + " ".repeat(MAX_ELEMENT_PICKER_MESSAGE_BYTES - body.length - 1);
      expect(raw.length).toBeLessThan(MAX_ELEMENT_PICKER_MESSAGE_BYTES);
      expect(utf8(raw)).toBeGreaterThan(MAX_ELEMENT_PICKER_MESSAGE_BYTES);
      expect(admitElementPickerMessage(raw, admission)).toEqual({ ok: false, reason: "oversized" });
    });

    it("rejects an oversized body before parsing it, even when it is not JSON at all", () => {
      const parse = vi.spyOn(JSON, "parse");
      const raw = `{${"x".repeat(MAX_ELEMENT_PICKER_MESSAGE_BYTES)}`;
      expect(admitElementPickerMessage(raw, admission)).toEqual({ ok: false, reason: "oversized" });
      expect(parse).not.toHaveBeenCalled();
    });
  });
});

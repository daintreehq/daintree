/**
 * The host's half of the guest wire contract: the one lifecycle event it acts
 * on is checked strictly, and every other event stays opaque so a guest
 * adapter's payloads need no member in `electron/` or `shared/`.
 */
import { describe, expect, it } from "vitest";

import { DOCUMENT_READY, GuestEventSchema } from "../guestProtocol.js";

describe("site preview guest protocol", () => {
  it("rejects a lifecycle event that does not match its shape", () => {
    // Without this, a malformed `documentReady` would fall through to the
    // opaque branch and still set readiness.
    expect(GuestEventSchema.safeParse({ type: DOCUMENT_READY }).success).toBe(false);
    expect(
      GuestEventSchema.safeParse({
        type: DOCUMENT_READY,
        routeId: null,
        url: "http://localhost:5173/",
        viewport: { width: 0, height: 100, deviceScaleFactor: 1 },
      }).success
    ).toBe(false);
    // Strict, alone among the events: a readiness event the host admits and the
    // adapter drops is a binding called ready for a document the panel never got.
    expect(
      GuestEventSchema.safeParse({
        type: DOCUMENT_READY,
        routeId: null,
        url: "http://localhost:5173/",
        viewport: { width: 100, height: 100, deviceScaleFactor: 1 },
        extra: true,
      }).success
    ).toBe(false);
  });

  it("leaves every other event opaque to the host", () => {
    expect(GuestEventSchema.safeParse({ type: "selection", node: {} }).success).toBe(true);
    expect(GuestEventSchema.safeParse({ type: "aria-tree-changed", tree: [] }).success).toBe(true);
    // A `type` is still mandatory, and bounded.
    expect(GuestEventSchema.safeParse({ tree: [] }).success).toBe(false);
    expect(GuestEventSchema.safeParse({ type: "" }).success).toBe(false);
    expect(GuestEventSchema.safeParse({ type: "x".repeat(65) }).success).toBe(false);
  });
});

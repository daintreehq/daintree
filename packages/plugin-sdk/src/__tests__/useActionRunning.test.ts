import { describe, expect, it } from "vitest";
import { useActionRunning } from "../react/useActionRunning.js";

describe("useActionRunning", () => {
  it("reads one action from the view's running set", () => {
    const view = { runningActions: ["acme.ledger.refresh-quotes"] };
    expect(useActionRunning(view, "acme.ledger.refresh-quotes")).toBe(true);
    expect(useActionRunning(view, "acme.ledger.export")).toBe(false);
  });

  it("reads false on a host that does not track runs", () => {
    expect(useActionRunning({}, "acme.ledger.refresh-quotes")).toBe(false);
  });
});

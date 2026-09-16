// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { buildGuestRuntimeBody } from "../../guest/source.js";
import {
  GUEST_RUNTIME_GLOBAL,
  buildDisposeSource,
  buildGuestRuntimeSource,
  buildModeUpdateSource,
} from "../../../../../electron/services/sitePreview/guestRuntime.js";
import { validateGuestEnvelope } from "../../../../../electron/services/sitePreview/guestProtocol.js";
import type { GuestEnvelope } from "../protocol.js";

/**
 * The two halves of the guest boundary were built in parallel: the host's
 * prelude, which owns the envelope and reinstalls per document, and the page
 * runtime, which draws the overlay and reads Svelte's metadata. Each was tested
 * against its own idea of the other.
 *
 * These tests run the real composition — the host's prelude wrapping the
 * runtime body — and push every message through the host's own validator.
 * A message the host would drop is a failure here, not a silent dead inspector.
 */

const scope = globalThis as unknown as Record<string, unknown>;
const BINDING = "__daintreeSitePreviewBinding";
const SESSION = "session-integration";
const EPOCH = 3;
const INSTALL = 41;

let raw: string[] = [];

function install(mode: "browse" | "select" = "select"): void {
  scope[BINDING] = (payload: string) => {
    raw.push(payload);
  };
  const source = buildGuestRuntimeSource({
    sessionId: SESSION,
    installId: INSTALL,
    documentEpoch: EPOCH,
    bindingName: BINDING,
    mode,
    runtimeSource: buildGuestRuntimeBody(),
  });
  // Evaluated as source text with no module scope, exactly as CDP delivers it.
  new Function(source)();
}

function evaluate(source: string): void {
  new Function(source)();
}

/** Runs every captured payload through the host validator, in order. */
function acceptedEnvelopes(): GuestEnvelope[] {
  let lastSequence = -1;
  return raw.map((payload) => {
    const verdict = validateGuestEnvelope(payload, {
      sessionId: SESSION,
      documentEpoch: EPOCH,
      lastSequence,
    });
    if (!verdict.ok) throw new Error(`host rejected a guest message: ${verdict.reason}`);
    lastSequence = verdict.envelope.sequence;
    return verdict.envelope;
  });
}

function svelteButton(): Element {
  document.body.innerHTML = '<button id="cta">Start Pro</button>';
  const node = document.body.querySelector("#cta")!;
  (node as unknown as { __svelte_meta: unknown }).__svelte_meta = {
    loc: { file: "src/lib/PricingCard.svelte", line: 12, column: 4 },
    parent: {
      type: "component",
      file: "src/routes/pricing/+page.svelte",
      line: 8,
      column: 2,
      componentTag: "PricingCard",
      parent: null,
    },
  };
  return node;
}

afterEach(() => {
  const api = scope[GUEST_RUNTIME_GLOBAL] as { dispose?: (() => void) | null } | undefined;
  try {
    api?.dispose?.();
  } catch {
    // a failed dispose is asserted where it matters, not in cleanup
  }
  delete scope[GUEST_RUNTIME_GLOBAL];
  delete scope[BINDING];
  delete scope["__daintreeSiteBuilderGuest.state"];
  raw = [];
  document.body.innerHTML = "";
});

describe("host prelude + page runtime", () => {
  it("produces only envelopes the host accepts, numbered by the prelude", () => {
    const node = svelteButton();
    install("select");

    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const envelopes = acceptedEnvelopes();
    expect(envelopes.length).toBeGreaterThan(0);
    // The prelude owns the sequence, so it must be strictly increasing from 0
    // regardless of how the runtime counts internally.
    expect(envelopes.map((e) => e.sequence)).toEqual(envelopes.map((_, index) => index));
    for (const envelope of envelopes) {
      expect(envelope.sessionId).toBe(SESSION);
      expect(envelope.documentEpoch).toBe(EPOCH);
    }
  });

  it("reports the clicked element's Svelte location and ancestry verbatim", () => {
    const node = svelteButton();
    install("select");

    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const selection = acceptedEnvelopes()
      .map((e) => e.event)
      .find((event) => event.type === "selectionChanged");
    if (!selection || selection.type !== "selectionChanged") {
      throw new Error("no selectionChanged event reached the host");
    }
    const observed = selection.nodes[0]!;
    expect(observed.loc).toEqual({ file: "src/lib/PricingCard.svelte", line: 12, column: 4 });
    expect(observed.ancestry[0]).toMatchObject({
      type: "component",
      file: "src/routes/pricing/+page.svelte",
      componentTag: "PricingCard",
    });
  });

  it("does not activate the clicked element in select mode", () => {
    const node = svelteButton();
    let activated = false;
    node.addEventListener("click", () => {
      activated = true;
    });
    install("select");

    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(activated).toBe(false);
  });

  it("reaches the runtime through the host's mode update and stops intercepting", () => {
    const node = svelteButton();
    let activated = false;
    node.addEventListener("click", () => {
      activated = true;
    });
    install("select");

    evaluate(buildModeUpdateSource("browse"));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    // In browse mode the site behaves as if the builder were not there.
    expect(activated).toBe(true);
    expect(acceptedEnvelopes().some((envelope) => envelope.event.type === "selectionChanged")).toBe(
      false
    );
  });

  it("tears the runtime down through the host's disposer, matched on install id", () => {
    svelteButton();
    install("select");
    const api = scope[GUEST_RUNTIME_GLOBAL] as { installId: number };
    expect(api.installId).toBe(INSTALL);

    // A disposer for a different install must leave this runtime alone.
    evaluate(buildDisposeSource(INSTALL + 1));
    expect(scope[GUEST_RUNTIME_GLOBAL]).toBeDefined();

    evaluate(buildDisposeSource(INSTALL));
    expect(scope[GUEST_RUNTIME_GLOBAL]).toBeUndefined();
  });

  it("lets the next document's install take over, and the host accepts its traffic", () => {
    // The host reinstalls per document with a fresh epoch; a second install for
    // the *same* epoch is prevented on the host side, because its sequence would
    // restart at 0 and read as a replay. So the takeover worth testing is the
    // real one: a newer install, a newer epoch, and messages the host accepts.
    const node = svelteButton();
    install("select");

    raw = [];
    evaluate(
      buildGuestRuntimeSource({
        sessionId: SESSION,
        installId: INSTALL + 1,
        documentEpoch: EPOCH + 1,
        bindingName: BINDING,
        mode: "select",
        runtimeSource: buildGuestRuntimeBody(),
      })
    );
    expect((scope[GUEST_RUNTIME_GLOBAL] as { installId: number }).installId).toBe(INSTALL + 1);

    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    let lastSequence = -1;
    expect(raw.length).toBeGreaterThan(0);
    for (const payload of raw) {
      const verdict = validateGuestEnvelope(payload, {
        sessionId: SESSION,
        documentEpoch: EPOCH + 1,
        lastSequence,
      });
      if (!verdict.ok)
        throw new Error(`host rejected the new install's message: ${verdict.reason}`);
      lastSequence = verdict.envelope.sequence;
    }
  });
});

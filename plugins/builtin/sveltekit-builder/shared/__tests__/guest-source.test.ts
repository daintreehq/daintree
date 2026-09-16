// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  GUEST_BINDING_NAME,
  GUEST_HANDLE_NAME,
  buildStandaloneGuestSource,
} from "../../renderer/guest/source.js";
import type { GuestBootstrapConfig, GuestRuntimeHandle } from "../../renderer/guest/types.js";
import { GUEST_PROTOCOL_VERSION, GuestEnvelopeSchema, type GuestEnvelope } from "../protocol.js";

const scope = globalThis as unknown as Record<string, unknown>;
let envelopes: GuestEnvelope[] = [];

function config(overrides: Partial<GuestBootstrapConfig> = {}): GuestBootstrapConfig {
  return {
    protocolVersion: GUEST_PROTOCOL_VERSION,
    sessionId: "session-1",
    documentEpoch: 7,
    mode: "select",
    bindingName: GUEST_BINDING_NAME,
    handleName: GUEST_HANDLE_NAME,
    ...overrides,
  };
}

/**
 * Evaluates the runtime the way the host does — as source text with no module
 * loader, no imports and no closure. Anything the factory accidentally captured
 * from module scope surfaces here as a ReferenceError.
 */
function inject(overrides: Partial<GuestBootstrapConfig> = {}): GuestRuntimeHandle {
  const source = buildStandaloneGuestSource(config(overrides));
  new Function("return " + source + ";")();
  return scope[overrides.handleName ?? GUEST_HANDLE_NAME] as GuestRuntimeHandle;
}

function card(): Element {
  document.body.innerHTML = '<button id="cta">Buy</button>';
  const node = document.body.querySelector("#cta")!;
  (node as unknown as { __svelte_meta: unknown }).__svelte_meta = {
    loc: { file: "src/routes/+page.svelte", line: 5, column: 2 },
  };
  return node;
}

afterEach(() => {
  const handle = scope[GUEST_HANDLE_NAME] as GuestRuntimeHandle | undefined;
  handle?.dispose();
  delete scope[GUEST_HANDLE_NAME];
  delete scope[GUEST_HANDLE_NAME + ".state"];
  delete scope[GUEST_BINDING_NAME];
  envelopes = [];
  document.body.innerHTML = "";
});

function bind(): void {
  scope[GUEST_BINDING_NAME] = (payload: string) => {
    envelopes.push(GuestEnvelopeSchema.parse(JSON.parse(payload)));
  };
}

describe("buildStandaloneGuestSource", () => {
  it("runs standalone and publishes a working handle", () => {
    bind();
    const node = card();
    const handle = inject();

    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(handle.getMode()).toBe("select");
    expect(envelopes.map((envelope) => envelope.event.type)).toEqual([
      "documentReady",
      "selectionChanged",
    ]);
    expect(envelopes[0].documentEpoch).toBe(7);
  });

  it("hands over cleanly when the host injects it again", () => {
    bind();
    const node = card();
    inject();
    inject({ documentEpoch: 8 });
    envelopes = [];

    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    // One runtime answering, not two: the previous one disposed on re-injection.
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].documentEpoch).toBe(8);
  });

  it("carries on counting when it is re-injected into the same document", () => {
    bind();
    const node = card();
    inject();
    inject();
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    // The host validates the sequence against the epoch, so a replacement
    // runtime replaying 0 would have its messages rejected as stale.
    expect(envelopes.map((envelope) => envelope.sequence)).toEqual([0, 1, 2]);
  });

  it("starts from zero again when the document epoch moves", () => {
    bind();
    card();
    inject();
    inject({ documentEpoch: 9 });

    expect(envelopes.map((envelope) => envelope.sequence)).toEqual([0, 0]);
  });

  it("removes its global on dispose", () => {
    bind();
    card();
    inject().dispose();

    expect(GUEST_HANDLE_NAME in scope).toBe(false);
  });

  it("escapes config text that would otherwise break out of the source", () => {
    bind();
    card();
    const sessionId = "</script>\u2028\u2029'\"";
    inject({ sessionId });

    expect(buildStandaloneGuestSource(config({ sessionId }))).not.toContain("</script>");
    expect(envelopes[0].sessionId).toBe(sessionId);
  });
});

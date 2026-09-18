// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildGuestAsset } from "./buildGuestAsset.js";
import {
  GUEST_RUNTIME_GLOBAL,
  buildDisposeSource,
  buildGuestRuntimeSource,
  buildModeUpdateSource,
  buildReselectSource,
} from "../../../../../electron/services/sitePreview/guestRuntime.js";
import {
  GuestEventSchema as HostGuestEventSchema,
  validateGuestEnvelope,
} from "../../../../../electron/services/sitePreview/guestProtocol.js";
import { GuestEventSchema, type GuestEnvelope } from "../protocol.js";

/**
 * The two halves of the guest boundary were built in parallel: the host's
 * prelude, which owns the envelope and reinstalls per document, and the page
 * runtime, which draws the overlay and reads Svelte's metadata. Each was tested
 * against its own idea of the other.
 *
 * These tests run the real composition — the host's prelude wrapping the built
 * guest asset, the same text the host's adapter loads from disk — and push
 * every message through the host's own validator. A message the host would drop
 * is a failure here, not a silent dead inspector.
 */

const scope = globalThis as unknown as Record<string, unknown>;
const BINDING = "__daintreeSitePreviewBinding";
const SESSION = "session-integration";
const EPOCH = 3;
const INSTALL = 41;

let raw: string[] = [];
let body = "";

beforeAll(() => {
  body = buildGuestAsset();
}, 60_000);

function install(
  mode: "browse" | "select" = "select",
  origins: "any" | "local-preview" = "any"
): void {
  scope[BINDING] = (payload: string) => {
    raw.push(payload);
  };
  const source = buildGuestRuntimeSource({
    sessionId: SESSION,
    installId: INSTALL,
    documentEpoch: EPOCH,
    bindingName: BINDING,
    mode,
    runtimeSource: body,
    origins,
  });
  // Evaluated as source text with no module scope, exactly as CDP delivers it.
  new Function(source)();
}

function evaluate(source: string): void {
  new Function(source)();
}

/**
 * Runs every captured payload through both halves of the boundary, in order:
 * the host validates the envelope and the adapter's own schema validates the
 * payload. A message either half would drop is a failure here.
 */
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
    const event = GuestEventSchema.safeParse(verdict.envelope.event);
    if (!event.success) {
      throw new Error(
        `the adapter schema rejected a "${String(verdict.envelope.event.type)}" event`
      );
    }
    return { ...verdict.envelope, event: event.data };
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

describe("the lifecycle event both halves validate", () => {
  // `documentReady` is the one payload the host and the adapter both declare —
  // the host marks a binding ready on its verdict, the adapter draws the page
  // on its own. A body only one of them accepts is a binding the user is told
  // is ready with nothing in it, so they have to accept the same language, not
  // merely name the same fields.
  const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };

  it.each([
    { case: "the shape both declare", body: { routeId: null, url: "http://site/", viewport } },
    { case: "a named route", body: { routeId: "/pricing", url: "http://site/pricing", viewport } },
    { case: "nothing but the discriminant", body: {} },
    { case: "a retyped field", body: { routeId: 3, url: "http://site/", viewport } },
    {
      case: "an extra field",
      body: { routeId: null, url: "http://site/", viewport, extra: true },
    },
    {
      case: "an impossible viewport",
      body: { routeId: null, url: "http://site/", viewport: { ...viewport, width: 0 } },
    },
  ])("agrees on $case", ({ body }) => {
    const event = { type: "documentReady", ...body };
    const adapter = GuestEventSchema.safeParse(event).success;
    expect(HostGuestEventSchema.safeParse(event).success).toBe(adapter);
  });
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
        runtimeSource: body,
        origins: "any",
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

  it("keeps a widened component through the host's own reselect source", () => {
    svelteButton();
    install("select");
    const callSite = { file: "src/routes/pricing/+page.svelte", line: 8, column: 2 };
    const result = new Function(
      `return ${buildReselectSource({ file: "src/lib/PricingCard.svelte", line: 12, column: 4 }, 0, callSite)}`
    )();
    expect(result).toBe(true);
    const selections = acceptedEnvelopes().filter(
      (envelope) => envelope.event.type === "selectionChanged"
    );
    const last = selections[selections.length - 1]?.event;
    expect(last).toMatchObject({ scope: "component", cause: "reselect" });
  });
});

describe("origin policy in the injected script", () => {
  it("installs nothing on a document outside the adapter's origins", () => {
    // The audit's experiment: the compiled prelude and the real guest asset
    // evaluated at https://example.com/oauth. It used to install and intercept
    // a click. `Page.addScriptToEvaluateOnNewDocument` runs in the new document
    // before main observes the navigation, so the host's own check cannot be
    // what stops this — the script has to refuse itself.
    const denied = buildGuestRuntimeSource({
      sessionId: SESSION,
      installId: INSTALL,
      documentEpoch: EPOCH,
      bindingName: BINDING,
      mode: "select",
      runtimeSource: body,
      origins: "local-preview",
    });
    // jsdom serves this suite from localhost, so the denied document is faked
    // the only way the guard can see it: through `location`.
    const evaluateAt = (href: string, source: string): void => {
      new Function("location", source)({ href });
    };
    evaluateAt("https://example.com/oauth", denied);

    expect(scope[GUEST_RUNTIME_GLOBAL]).toBeUndefined();

    const node = document.createElement("button");
    document.body.appendChild(node);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    // Nothing installed, so nothing intercepted and nothing was reported.
    expect(event.defaultPrevented).toBe(false);
    expect(raw).toEqual([]);

    // The same script at a local address installs as usual.
    evaluateAt("http://localhost:5173/", denied);
    expect(scope[GUEST_RUNTIME_GLOBAL]).toBeDefined();
  });
});

/**
 * The host's half of the guest wire contract: the envelope, and nothing about
 * what an adapter puts inside it.
 *
 * The split is deliberate. The host owns transport — protocol version, session,
 * document epoch, sequence, byte ceiling — and the single lifecycle event it
 * acts on (`documentReady`, which flips a binding's readiness). Every other
 * event is opaque here: a `type` the host can route and count, and a body it
 * forwards without interpreting. The adapter that installed the guest runtime
 * validates that body against its own schema before using it — for the
 * SvelteKit builder, `GuestEventSchema` in
 * `plugins/builtin/sveltekit-builder/shared/protocol.ts`, parsed in its
 * renderer controller. So a React or CSS inspector adds no member here, which
 * is the point: `electron/` may not import from `plugins/`, and the old mirror
 * of the plugin's payload union made core carry Svelte-shaped types it could
 * not maintain. `SitePreviewBridgeProtocolDrift.test.ts` pins what still has to
 * agree across the split.
 *
 * Everything below describes traffic from an untrusted page. A dev preview runs
 * whatever the user is building, and a same-origin compromise can forge any
 * field. These schemas therefore only establish that a message is *well formed
 * and current*; they confer no authority. Source identity is re-resolved from
 * source, never taken from a guest's `__svelte_meta` reading.
 */

import { z } from "zod";
import type {
  SiteGuestDocumentReady,
  SiteGuestEvent,
} from "../../../shared/types/ipc/sitePreview.js";

/**
 * Bumped whenever a guest-visible shape changes. The host refuses envelopes
 * from a runtime built against a different version, which is what keeps a stale
 * injected script from a previous app version talking to a newer host.
 */
export const GUEST_PROTOCOL_VERSION = 1;

/** Hard ceiling on one envelope, enforced on the raw string before parsing. */
export const MAX_GUEST_MESSAGE_BYTES = 256 * 1024;

/** The only event type the host itself interprets. */
export const DOCUMENT_READY = "documentReady";

const ViewportSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
  })
  .strict();

/**
 * The lifecycle event the host understands. Validated here, not left to the
 * adapter, because the bridge acts on it: a well-formed `documentReady` is what
 * marks a binding ready.
 *
 * Strict, unlike every other event, and deliberately: this one shape is shared
 * with the adapter, whose own declaration is strict too. Were the host lenient
 * about extras the two would accept different languages, and a readiness event
 * the host admitted could be one the adapter drops — the host calling a binding
 * ready for a document the panel never received. Extending it is a change to
 * the host contract, which is what the drift test makes visible.
 */
export const GuestDocumentReadySchema = z.strictObject({
  type: z.literal(DOCUMENT_READY),
  routeId: z.string().max(512).nullable(),
  url: z.string().max(2048),
  viewport: ViewportSchema,
});

/**
 * Every other event, as far as the host is concerned: a routable `type` and an
 * uninspected body. `documentReady` is excluded so a malformed lifecycle event
 * is rejected outright rather than quietly demoted to an opaque event the host
 * would still take readiness from.
 */
const GuestOpaqueEventSchema = z
  .looseObject({ type: z.string().min(1).max(64) })
  .refine((event) => event.type !== DOCUMENT_READY, {
    message: `${DOCUMENT_READY} must match the lifecycle shape`,
  });

export const GuestEventSchema = z.union([GuestDocumentReadySchema, GuestOpaqueEventSchema]);

export const GuestEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(GUEST_PROTOCOL_VERSION),
    sessionId: z.string().min(1).max(128),
    documentEpoch: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    event: GuestEventSchema,
  })
  .strict();

export type GuestEnvelope = z.infer<typeof GuestEnvelopeSchema>;

// The shared structural type and the schema here must describe the same value.
// It has to be asserted on `documentReady` specifically: an opaque event is a
// `type` plus anything, so it subsumes every object and an assertion against
// the union as a whole would hold however wrong the lifecycle fields were.
// Both directions, so neither side can gain, lose or retype a field unnoticed.
type _ReadySchemaSatisfiesShared =
  z.infer<typeof GuestDocumentReadySchema> extends SiteGuestDocumentReady ? true : never;
type _SharedReadySatisfiesSchema =
  SiteGuestDocumentReady extends z.infer<typeof GuestDocumentReadySchema> ? true : never;
// And that the envelope's event still satisfies the shared type at all.
type _SchemaSatisfiesShared =
  z.infer<typeof GuestEventSchema> extends SiteGuestEvent ? true : never;
const _guestEventShapesAgree: [
  _ReadySchemaSatisfiesShared,
  _SharedReadySatisfiesSchema,
  _SchemaSatisfiesShared,
] = [true, true, true];
void _guestEventShapesAgree;

export type GuestEnvelopeRejection =
  /** The call did not come from the main frame's default world. */
  | "foreign-context"
  /** The binding's per-second parse budget was already spent. */
  | "rate-limited"
  | "oversized"
  | "malformed"
  | "protocol-version"
  | "unknown-session"
  | "stale-epoch"
  | "replayed-sequence";

export type GuestEnvelopeVerdict =
  { ok: true; envelope: GuestEnvelope } | { ok: false; reason: GuestEnvelopeRejection };

export interface GuestEnvelopeExpectation {
  sessionId: string;
  documentEpoch: number;
  /** Highest sequence already accepted in this epoch, or -1 when none has been. */
  lastSequence: number;
}

/**
 * Validate one raw guest payload against a binding's expectations, before any
 * part of it is interpreted.
 *
 * The epoch comparison is strict equality, not "not older". The host bakes the
 * epoch into the runtime it installs and reinstalls on every document, so a
 * guest can only legitimately hold the current one; a higher value means either
 * a forgery or a script the host did not install, and either way there is no
 * document it could correctly describe.
 */
export function validateGuestEnvelope(
  raw: string,
  expectation: GuestEnvelopeExpectation
): GuestEnvelopeVerdict {
  // Code-unit length first: it is O(1) and never larger than the UTF-8 byte
  // count, so a string past the cap in code units is past it in bytes too and
  // an absurd body is rejected without scanning it.
  if (raw.length > MAX_GUEST_MESSAGE_BYTES) {
    return { ok: false, reason: "oversized" };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_GUEST_MESSAGE_BYTES) {
    return { ok: false, reason: "oversized" };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const parsed = GuestEnvelopeSchema.safeParse(parsedJson);
  if (!parsed.success) {
    // Separate the version mismatch from a generic shape failure so a stale
    // runtime from an older app version is diagnosable rather than just noise.
    const version = (parsedJson as { protocolVersion?: unknown } | null)?.protocolVersion;
    if (version !== undefined && version !== GUEST_PROTOCOL_VERSION) {
      return { ok: false, reason: "protocol-version" };
    }
    return { ok: false, reason: "malformed" };
  }

  const envelope = parsed.data;
  if (envelope.sessionId !== expectation.sessionId) {
    return { ok: false, reason: "unknown-session" };
  }
  if (envelope.documentEpoch !== expectation.documentEpoch) {
    return { ok: false, reason: "stale-epoch" };
  }
  if (envelope.sequence <= expectation.lastSequence) {
    return { ok: false, reason: "replayed-sequence" };
  }

  return { ok: true, envelope };
}

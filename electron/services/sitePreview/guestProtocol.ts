/**
 * Core-side mirror of the guest half of the Site Builder wire contract.
 *
 * The plugin owns the canonical declaration in
 * `plugins/builtin/sveltekit-builder/shared/protocol.ts`, but `electron/` may
 * not import from `plugins/` — so the shape is restated here and
 * `SitePreviewBridgeProtocolDrift.test.ts` fails if the two ever disagree.
 *
 * Everything below describes traffic from an untrusted page. A dev preview runs
 * whatever the user is building, and a same-origin compromise can forge any
 * field. These schemas therefore only establish that a message is *well formed
 * and current*; they confer no authority. Source identity is re-resolved by the
 * host from the guest's raw `__svelte_meta` reading, never taken on trust.
 */

import { z } from "zod";
import type { SiteGuestEvent } from "../../../shared/types/ipc/sitePreview.js";

/**
 * Bumped whenever a guest-visible shape changes. The host refuses envelopes
 * from a runtime built against a different version, which is what keeps a stale
 * injected script from a previous app version talking to a newer host.
 */
export const GUEST_PROTOCOL_VERSION = 1;

/** Hard ceiling on one envelope, enforced on the raw string before parsing. */
export const MAX_GUEST_MESSAGE_BYTES = 256 * 1024;

const SourceLocationSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive(),
    column: z.number().int().nonnegative(),
  })
  .strict();

const RectSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();

const ViewportSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
  })
  .strict();

export const GuestNodeObservationSchema = z
  .object({
    runtimeOccurrenceId: z.string().min(1).max(128),
    loc: SourceLocationSchema.nullable(),
    ancestry: z
      .array(
        z
          .object({
            type: z.string().min(1).max(32),
            file: z.string().min(1).max(1024),
            line: z.number().int().positive(),
            column: z.number().int().nonnegative(),
            componentTag: z.string().min(1).max(128).optional(),
          })
          .strict()
      )
      .max(64),
    tagName: z.string().min(1).max(64),
    sameLocCount: z.number().int().positive().max(100_000),
    label: z.string().max(200),
    bounds: z.array(RectSchema).max(32),
    unmapped: z.boolean(),
  })
  .strict();

export const GuestEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("documentReady"),
      routeId: z.string().max(512).nullable(),
      url: z.string().max(2048),
      viewport: ViewportSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("selectionChanged"),
      nodes: z.array(GuestNodeObservationSchema).max(32),
      /** Present when the nodes are one component invocation's rendered roots. */
      scope: z.literal("component").optional(),
      /**
       * The call site of the component that was selected, as it appears on the
       * primary node's parent chain. A location, not a position in the chain: a
       * dropped or truncated frame must not make it name a different component.
       * A wrapper with no element of its own shares its roots with the component
       * inside it, so the roots alone cannot say which one was meant.
       */
      component: z
        .object({
          file: z.string().min(1).max(1024),
          line: z.number().int().positive(),
          column: z.number().int().nonnegative(),
          /** The tag it was written as at that call site. */
          name: z.string().min(1).max(128),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hoverChanged"),
      node: GuestNodeObservationSchema.nullable(),
    })
    .strict(),
  z
    .object({ type: z.literal("mappingRevisionSeen"), revision: z.string().min(1).max(128) })
    .strict(),
  z
    .object({
      type: z.literal("runtimeIssue"),
      code: z.enum(["no-svelte-meta", "not-dev-build", "overlay-blocked", "internal"]),
      detail: z.string().max(512),
    })
    .strict(),
]);

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
// Both directions are asserted so neither side can gain or lose a member
// unnoticed; a mismatch is a compile error rather than a runtime surprise.
type _SchemaSatisfiesShared =
  z.infer<typeof GuestEventSchema> extends SiteGuestEvent ? true : never;
type _SharedSatisfiesSchema =
  SiteGuestEvent extends z.infer<typeof GuestEventSchema> ? true : never;
const _guestEventShapesAgree: [_SchemaSatisfiesShared, _SharedSatisfiesSchema] = [true, true];
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
  // Code-unit length first: it is O(1) and never smaller than the UTF-8 byte
  // count, so an absurd body is rejected without scanning it.
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

import { z } from "zod";
import { utf8ByteLength } from "../utils/boundedOutput.js";
import {
  FrameworkDetectionSchema,
  HoverObservationSchema,
  MAX_RECT_PX,
  OBSERVATION_LIMITS,
  SelectionObservationSchema,
} from "./observation.js";
import { ElementPickerProviderIdSchema, PickerIdSchema } from "./source.js";

/**
 * The page-to-host wire contract. The page is untrusted: it is whatever the
 * user is building, and a same-origin compromise can forge any field. So these
 * schemas establish that a message is well formed and current, and confer no
 * authority: everything in it is an observation for the host to resolve.
 */

/**
 * Bumped whenever a guest-visible shape changes, so a runtime injected by an
 * older app version cannot talk to a newer host.
 */
export const ELEMENT_PICKER_PROTOCOL_VERSION = 2;

/** Hard ceiling on one envelope, measured in UTF-8 bytes on the raw string before parsing. */
export const MAX_ELEMENT_PICKER_MESSAGE_BYTES = 256 * 1024;

export const SELECTION_LIMITS = { observations: 32 } as const;

/**
 * What the selection is of. A component selection names the component, not
 * only its roots: a wrapper with no element of its own shares its roots with
 * the component inside it, so the roots alone cannot say which was meant.
 */
export const SelectionScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("element") }),
  z.strictObject({ kind: z.literal("component"), componentId: PickerIdSchema }),
]);
export type SelectionScope = z.infer<typeof SelectionScopeSchema>;

const SelectionChangedSchema = z
  .strictObject({
    type: z.literal("selectionChanged"),
    observations: z.array(SelectionObservationSchema).max(SELECTION_LIMITS.observations),
    /** The user (click, key, Escape), the document (the node left it), or the host's own reselect. */
    cause: z.enum(["user", "document", "reselect"]),
    scope: SelectionScopeSchema,
  })
  .superRefine((event, ctx) => {
    const ids = event.observations.map((observation) => observation.elementId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["observations"], message: "duplicate element id" });
    }
    const scope = event.scope;
    if (
      scope.kind === "component" &&
      !event.observations.some((observation) =>
        observation.componentChain.components.some(
          (record) => record.componentId === scope.componentId
        )
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["scope", "componentId"],
        message: "names no component in the selection",
      });
    }
  });

export const ElementPickerEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("documentReady"),
    url: z.string().max(2048),
    viewport: z.strictObject({
      width: z.number().int().positive().max(MAX_RECT_PX),
      height: z.number().int().positive().max(MAX_RECT_PX),
      /** `devicePixelRatio`, which browser zoom multiplies, so it runs well past any display's own. */
      deviceScaleFactor: z.number().positive().max(64),
    }),
  }),
  /** What the bootstrap's detectors found; the host decides from it which extractors to inject. */
  z.strictObject({
    type: z.literal("frameworksDetected"),
    detections: z.array(FrameworkDetectionSchema).max(OBSERVATION_LIMITS.detections),
  }),
  z.strictObject({
    type: z.literal("hoverChanged"),
    observation: HoverObservationSchema.nullable(),
  }),
  SelectionChangedSchema,
  z.strictObject({
    type: z.literal("runtimeIssue"),
    /**
     * `not-dev-build` and `metadata-unavailable` both mean a framework's page
     * carries none of its dev metadata; the second is said where the page is
     * visibly served by a dev server, which a production build is not.
     */
    code: z.enum([
      "not-dev-build",
      "metadata-unavailable",
      "overlay-blocked",
      "capacity",
      "extractor-failed",
      "internal",
    ]),
    framework: ElementPickerProviderIdSchema.optional(),
    detail: z.string().max(512),
  }),
]);
export type ElementPickerEvent = z.infer<typeof ElementPickerEventSchema>;

export const ElementPickerEnvelopeSchema = z.strictObject({
  protocolVersion: z.literal(ELEMENT_PICKER_PROTOCOL_VERSION),
  /** Host-issued, per binding. It scopes; it does not authorise. */
  sessionId: z.string().min(1).max(128),
  documentEpoch: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  event: ElementPickerEventSchema,
});
export type ElementPickerEnvelope = z.infer<typeof ElementPickerEnvelopeSchema>;

/**
 * What one binding expects next. Owned by the host per binding and advanced
 * only by an admitted message; the epoch moves when the host replaces the
 * document, never because a page said so.
 */
export interface ElementPickerAdmission {
  readonly sessionId: string;
  readonly documentEpoch: number;
  /** Highest sequence admitted in this epoch, or -1 before the first. */
  readonly lastSequence: number;
}

export type ElementPickerRejection =
  | "oversized"
  | "malformed"
  | "protocol-version"
  | "unknown-session"
  | "stale-epoch"
  | "replayed-sequence";

export type ElementPickerVerdict =
  | { ok: true; envelope: ElementPickerEnvelope; admission: ElementPickerAdmission }
  | { ok: false; reason: ElementPickerRejection };

/**
 * Admit one raw page message, or say why not, before any of it is interpreted.
 * The size gate runs before `JSON.parse` so an oversized body is never parsed.
 * The epoch must match exactly: the host bakes it into the runtime it installs
 * per document, so a newer one is a forgery as surely as an older one is
 * stale. Sequences may skip (a message the page dropped) but never repeat or
 * go back.
 */
export function admitElementPickerMessage(
  raw: unknown,
  admission: ElementPickerAdmission
): ElementPickerVerdict {
  if (typeof raw !== "string") return { ok: false, reason: "malformed" };
  // A code unit is at least one UTF-8 byte, so this rejects an absurd body
  // without encoding it.
  if (raw.length > MAX_ELEMENT_PICKER_MESSAGE_BYTES) return { ok: false, reason: "oversized" };
  if (utf8ByteLength(raw) > MAX_ELEMENT_PICKER_MESSAGE_BYTES) {
    return { ok: false, reason: "oversized" };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const parsed = ElementPickerEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    const version = (json as { protocolVersion?: unknown } | null)?.protocolVersion;
    const versionMismatch = version !== undefined && version !== ELEMENT_PICKER_PROTOCOL_VERSION;
    return { ok: false, reason: versionMismatch ? "protocol-version" : "malformed" };
  }

  const envelope = parsed.data;
  if (envelope.sessionId !== admission.sessionId) return { ok: false, reason: "unknown-session" };
  if (envelope.documentEpoch !== admission.documentEpoch) {
    return { ok: false, reason: "stale-epoch" };
  }
  if (envelope.sequence <= admission.lastSequence) {
    return { ok: false, reason: "replayed-sequence" };
  }

  return {
    ok: true,
    envelope,
    admission: { ...admission, lastSequence: envelope.sequence },
  };
}

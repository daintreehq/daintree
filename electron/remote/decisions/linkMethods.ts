import { z } from "zod";
import {
  MAX_HOST_DETAIL_LENGTH,
  type HostAcceptResult,
  type HostEnrollRefusal,
  type HostIdentityReport,
  type HostRequestResult,
} from "../../types/decisionsHosts.js";

/**
 * The session-level method a Decisions owner enrolls a Remote Host through
 * (#16021). A CALL, not a new frame kind: a host from before it answers
 * UNSUPPORTED, and Settings says it needs updating.
 */
export const DecisionsLinkMethod = {
  /**
   * Shell → Host, in steps: `status` reads what the Host holds, `request` has
   * it make keys and return only their public halves, `accept` hands it the
   * owner's signed enrollment to check and seal into its own keychain.
   */
  ENROLL_HOST: "decisions.enrollHost",
} as const;

/**
 * Where each method is served. `host`: only a Host's sessions register it, so
 * it acts on the Host's own keys; a Shell answers it UNSUPPORTED.
 */
export const DECISIONS_LINK_METHOD_LOCALITY = {
  [DecisionsLinkMethod.ENROLL_HOST]: "host",
} as const satisfies Record<(typeof DecisionsLinkMethod)[keyof typeof DecisionsLinkMethod], "host">;

/** The relay protocol's id shape (installations, devices), which attempts reuse. */
const RelayId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
/** A P-256 public key as the protocol encodes it. */
const PublicKey = z.string().regex(/^[A-Za-z0-9_-]{87}$/);
/** The protocol's longest device label. */
export const MAX_HOST_LABEL_LENGTH = 60;
/** The library's own bound on an encoded request or enrollment. */
const MAX_ENROLLMENT_TEXT = 64 * 1024;
const Detail = z.string().max(MAX_HOST_DETAIL_LENGTH);

export const EnrollHostPayloadSchema = z.discriminatedUnion("step", [
  z.object({ step: z.literal("status") }),
  z.object({
    step: z.literal("request"),
    attempt: RelayId,
    label: z.string().min(1).max(MAX_HOST_LABEL_LENGTH),
    /** The Host identity to replace, by device id: a revoked or stale one, on Enroll. */
    replace: RelayId.optional(),
  }),
  z.object({
    step: z.literal("accept"),
    attempt: RelayId,
    response: z.string().min(1).max(MAX_ENROLLMENT_TEXT),
  }),
]);
export type EnrollHostPayload = z.infer<typeof EnrollHostPayloadSchema>;

export const HostIdentityReportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("host"),
    relayOrigin: z.string().min(1).max(2048),
    installationId: RelayId,
    deviceId: RelayId,
    ownerDeviceId: RelayId,
    signingPub: PublicKey,
    exchangePub: PublicKey,
  }),
  z.object({ kind: z.literal("owner") }),
  z.object({ kind: z.literal("unreadable"), detail: Detail.optional() }),
]) satisfies z.ZodType<HostIdentityReport>;

const RefusalSchema = z.object({
  step: z.literal("refused"),
  reason: z.enum([
    "own-setup",
    "enrolled",
    "no-keychain",
    "unreadable",
    "stale-attempt",
    "rejected",
    "unsaved",
  ]),
  detail: Detail.optional(),
}) satisfies z.ZodType<HostEnrollRefusal>;

export const HostStatusResultSchema = z.object({
  step: z.literal("status"),
  identity: HostIdentityReportSchema,
});
export type HostStatusResult = z.infer<typeof HostStatusResultSchema>;

export const HostRequestResultSchema = z.discriminatedUnion("step", [
  z.object({
    step: z.literal("requested"),
    request: z.string().startsWith("decisions-host-request.v1.").max(MAX_ENROLLMENT_TEXT),
  }),
  RefusalSchema,
]) satisfies z.ZodType<HostRequestResult>;

export const HostAcceptResultSchema = z.discriminatedUnion("step", [
  z.object({ step: z.literal("accepted"), deviceId: RelayId }),
  RefusalSchema,
]) satisfies z.ZodType<HostAcceptResult>;

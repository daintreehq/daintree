import { z } from "zod";
import type { DecisionsHostRuntime } from "../../../shared/types/decisionsHosts.js";
import {
  MAX_HOST_DETAIL_LENGTH,
  type HostAcceptResult,
  type HostEnrollRefusal,
  type HostIdentityReport,
  type HostRequestResult,
  type OwnerStateAnnouncement,
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
  /**
   * Shell → Host (#16022), on each connection and each change of the switch:
   * whether the owner's Decisions is on. The Host answers what it then
   * reports of its own Decisions.
   */
  OWNER_STATE: "decisions.ownerState",
  /**
   * Host → Shell (#16022): what the Host reports of its own Decisions changed,
   * sent to the Shells whose owner enrolled it. A Shell from before it
   * answers UNSUPPORTED, which changes nothing.
   */
  HOST_RUNTIME: "decisions.hostRuntime",
} as const;

/**
 * Where each method is served. `host`: only a Host's sessions register it, so
 * it acts on the Host's own keys and lifetime; a Shell answers it
 * UNSUPPORTED. `shell`: only a Shell's sessions register it.
 */
export const DECISIONS_LINK_METHOD_LOCALITY = {
  [DecisionsLinkMethod.ENROLL_HOST]: "host",
  [DecisionsLinkMethod.OWNER_STATE]: "host",
  [DecisionsLinkMethod.HOST_RUNTIME]: "shell",
} as const satisfies Record<
  (typeof DecisionsLinkMethod)[keyof typeof DecisionsLinkMethod],
  "host" | "shell"
>;

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

export const OwnerStatePayloadSchema = z
  .object({ installationId: RelayId, ownerDeviceId: RelayId, enabled: z.boolean() })
  .strict() satisfies z.ZodType<OwnerStateAnnouncement>;

/** A time a Host reports, as epoch ms. */
const Time = z.number().int().nonnegative();

export const HostRuntimeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not-enrolled") }),
  z.object({
    state: z.literal("running"),
    deviceId: RelayId,
    connection: z.enum([
      "not-connected",
      "connecting",
      "connected",
      "reconnecting",
      "replaced",
      "revoked",
    ]),
    nextAttemptAt: Time.optional(),
    problem: z.enum(["keys", "storage", "other-relay"]).optional(),
  }),
  z.object({ state: z.literal("owner-off"), deviceId: RelayId, since: Time }),
  z.object({
    state: z.literal("revoked"),
    deviceId: RelayId,
    since: Time,
    credentialsRemoved: z.boolean(),
  }),
]) satisfies z.ZodType<DecisionsHostRuntime>;

export const HostRuntimePayloadSchema = z.object({ runtime: HostRuntimeSchema }).strict();
export type HostRuntimePayload = z.infer<typeof HostRuntimePayloadSchema>;


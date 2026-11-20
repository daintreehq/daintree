import { z } from "zod";
import type {
  DecisionsHostQuestionPolicy,
  DecisionsHostRuntime,
} from "../../../shared/types/decisionsHosts.js";
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
   * Shell → Host (#16230): `OWNER_STATE` and whether terminal snapshots are
   * on. A Host from before it answers UNSUPPORTED, and is told `OWNER_STATE`
   * instead, so it shares none: the older method's payload is strict, and a
   * field it doesn't know would fail it.
   */
  OWNER_STATE_V2: "decisions.ownerState.v2",
  /**
   * Shell → Host (#17942): `OWNER_STATE_V2`, answered with a v2 report, whose
   * running Host also says how it asks its agents' questions. A Host from
   * before it answers UNSUPPORTED, and is told `OWNER_STATE_V2` instead: that
   * method's report is strict, so a field an older Shell doesn't know would
   * fail it.
   */
  OWNER_STATE_V3: "decisions.ownerState.v3",
  /**
   * Host → Shell (#16022): what the Host reports of its own Decisions changed,
   * sent to the Shells whose owner enrolled it. A Shell from before it
   * answers UNSUPPORTED, which changes nothing.
   */
  HOST_RUNTIME: "decisions.hostRuntime",
  /** Host → Shell (#17942): `HOST_RUNTIME` with a v2 report, to a Shell that announced with v3. */
  HOST_RUNTIME_V2: "decisions.hostRuntime.v2",
  /**
   * Shell → Host (#17230): the Host's own questions, as a content-free list,
   * and one of them read by reference (content, an image part, opening
   * lines). Answered only to the owner that enrolled the Host, while that
   * owner's Decisions is on. A Host from before it answers UNSUPPORTED, and
   * its questions aren't listed.
   */
  QUESTIONS: "decisions.questions",
  /** Shell → Host (#17230): the person withdrawing one of the Host's questions by reference. */
  CANCEL_QUESTION: "decisions.cancelQuestion",
  /**
   * Host → Shell (#17230): the Host's list changed, sent whole to the Shells
   * whose owner enrolled it. A Shell from before it answers UNSUPPORTED, and
   * is sent no more.
   */
  QUESTIONS_CHANGED: "decisions.questionsChanged",
  /**
   * Shell → Host (#17895): the Host's list as `QUESTIONS` reads it, with what
   * each of its questions in Needs you asks now. A Host from before it
   * answers UNSUPPORTED, and is read with `QUESTIONS` instead: that list's
   * items are strict, so a field an older Shell doesn't know would fail them.
   */
  QUESTION_LIST_V2: "decisions.questionList.v2",
  /**
   * Host → Shell (#17895): `QUESTIONS_CHANGED` with the asks, to a Shell
   * that read the list with `QUESTION_LIST_V2`, also when only an ask moved.
   */
  QUESTIONS_CHANGED_V2: "decisions.questionsChanged.v2",
  /**
   * Shell → Host (#17943): `QUESTION_LIST_V2` whose items also carry their
   * round: its mode, why it closed without an answer, and how far its closing
   * notice got. A Host from before it answers UNSUPPORTED, and is read with
   * `QUESTION_LIST_V2` instead: those items are strict, so a field an older
   * Shell doesn't know would fail them.
   */
  QUESTION_LIST_V3: "decisions.questionList.v3",
  /** Host → Shell (#17943): `QUESTIONS_CHANGED_V2` with v3 items, to a Shell that read v3. */
  QUESTIONS_CHANGED_V3: "decisions.questionsChanged.v3",
  /**
   * Shell → Host (#17943): one question's content as `QUESTIONS` reads it,
   * with its round and the plan its advisory round states. A Host from before
   * it answers UNSUPPORTED, and is read with `QUESTIONS` instead, whose
   * content is strict.
   */
  QUESTION_CONTENT_V2: "decisions.questionContent.v2",
  /**
   * Shell → Host (#18042): `QUESTION_CONTENT_V2` with the agent's account of
   * how it prepared the question. A Host from before it answers UNSUPPORTED,
   * and is read with `QUESTION_CONTENT_V2` instead, whose content is strict.
   */
  QUESTION_CONTENT_V3: "decisions.questionContent.v3",
  /**
   * Shell → Host (#18031): one of the Host's own stopped deliveries, by
   * reference, read with what the Host would offer, copied, resumed or marked
   * handled through the Host's own delivery, so resolving it once holds for
   * the Host's window too. Answered only to the owner that enrolled the Host,
   * while that owner's Decisions is on. A Host from before it answers
   * UNSUPPORTED, and its stalls are resolved on the Host.
   */
  ATTENTION: "decisions.attention",
} as const;

/**
 * Where each method is served. `host`: only a Host's sessions register it, so
 * it acts on the Host's own keys and lifetime; a Shell answers it
 * UNSUPPORTED. `shell`: only a Shell's sessions register it.
 */
export const DECISIONS_LINK_METHOD_LOCALITY = {
  [DecisionsLinkMethod.ENROLL_HOST]: "host",
  [DecisionsLinkMethod.OWNER_STATE]: "host",
  [DecisionsLinkMethod.OWNER_STATE_V2]: "host",
  [DecisionsLinkMethod.OWNER_STATE_V3]: "host",
  [DecisionsLinkMethod.HOST_RUNTIME]: "shell",
  [DecisionsLinkMethod.HOST_RUNTIME_V2]: "shell",
  [DecisionsLinkMethod.QUESTIONS]: "host",
  [DecisionsLinkMethod.CANCEL_QUESTION]: "host",
  [DecisionsLinkMethod.QUESTIONS_CHANGED]: "shell",
  [DecisionsLinkMethod.QUESTION_LIST_V2]: "host",
  [DecisionsLinkMethod.QUESTIONS_CHANGED_V2]: "shell",
  [DecisionsLinkMethod.QUESTION_LIST_V3]: "host",
  [DecisionsLinkMethod.QUESTIONS_CHANGED_V3]: "shell",
  [DecisionsLinkMethod.QUESTION_CONTENT_V2]: "host",
  [DecisionsLinkMethod.QUESTION_CONTENT_V3]: "host",
  [DecisionsLinkMethod.ATTENTION]: "host",
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
    /** The owner accepted the fixed-key storage for this Host, which has no keychain, on Enroll. */
    allowWeakStorage: z.literal(true).optional(),
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
    "weak-storage-only",
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
  .strict() satisfies z.ZodType<Omit<OwnerStateAnnouncement, "terminalSnapshots">>;

export const OwnerStateV2PayloadSchema = z
  .object({
    installationId: RelayId,
    ownerDeviceId: RelayId,
    enabled: z.boolean(),
    terminalSnapshots: z.boolean(),
  })
  .strict() satisfies z.ZodType<OwnerStateAnnouncement>;

/** A time a Host reports, as epoch ms. */
const Time = z.number().int().nonnegative();

const NotEnrolledSchema = z.object({ state: z.literal("not-enrolled") });
const RunningSchema = z.object({
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
});
const OwnerOffSchema = z.object({ state: z.literal("owner-off"), deviceId: RelayId, since: Time });
const RevokedSchema = z.object({
  state: z.literal("revoked"),
  deviceId: RelayId,
  since: Time,
  credentialsRemoved: z.boolean(),
});

export const HostRuntimeSchema = z.discriminatedUnion("state", [
  NotEnrolledSchema,
  RunningSchema,
  OwnerOffSchema,
  RevokedSchema,
]) satisfies z.ZodType<DecisionsHostRuntime>;

export const HostRuntimePayloadSchema = z.object({ runtime: HostRuntimeSchema }).strict();
export type HostRuntimePayload = z.infer<typeof HostRuntimePayloadSchema>;

/** The longest default expiry a policy accepts: under the relay's 366-day limit. */
const MAX_DEFAULT_EXPIRY_MS = 366 * 24 * 60 * 60 * 1000;

const QuestionPolicySchema = z
  .object({
    advisoryQuestions: z.boolean(),
    defaultQuestionExpiryMs: z.number().int().positive().max(MAX_DEFAULT_EXPIRY_MS).nullable(),
  })
  .strict() satisfies z.ZodType<DecisionsHostQuestionPolicy>;

/**
 * A v2 report (#17942): a running Host always says how it asks its agents'
 * questions, so a report without it is one from before, read with v1.
 */
export const HostRuntimeV2Schema = z.discriminatedUnion("state", [
  NotEnrolledSchema,
  RunningSchema.extend({ questionPolicy: QuestionPolicySchema }),
  OwnerOffSchema,
  RevokedSchema,
]) satisfies z.ZodType<DecisionsHostRuntime>;

export const HostRuntimeV2PayloadSchema = z.object({ runtime: HostRuntimeV2Schema }).strict();

/** A report as a Shell from before #17942 reads it: a running Host's without its question policy. */
export function legacyRuntime(runtime: DecisionsHostRuntime): DecisionsHostRuntime {
  if (runtime.state !== "running" || runtime.questionPolicy === undefined) return runtime;
  const { questionPolicy: _policy, ...legacy } = runtime;
  return legacy;
}

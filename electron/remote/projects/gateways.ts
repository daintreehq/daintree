import type { z } from "zod";
import type {
  CheckDestinationPayload,
  CheckOutBranchPayload,
  CloneAndOpenPayload,
  DescribeSourcePayload,
  DestinationCheck,
  FindProjectMatchPayload,
  HostCloneEnvironment,
  HostProjectOpened,
  OpenOnHostPayload,
  ProjectMatchCandidate,
  PushBranchOutcome,
  PushBranchPayload,
  SourceProjectDescription,
  SuggestDestinationPayload,
} from "../../../shared/types/ipc/projectMatch.js";
import type { HostId, OperationOutcome } from "../../../shared/types/remoteHosts.js";
import type { ProjectAcrossHostsService } from "../../services/projectAcrossHosts/index.js";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import {
  BundleCreatedSchema,
  BundleExpectedSchema,
  CandidatesSchema,
  DestinationSchema,
  EnvironmentSchema,
  OpenedSchema,
  OperationOutcomeSchema,
  ProjectLinkMethod,
  PushOutcomeSchema,
  SourceDescriptionSchema,
  type LinkPushBranchPayload,
  type LinkStartClonePayload,
} from "./linkMethods.js";

/** Longer than the host's own push timeout, so the host reports a stuck push first. */
const PUSH_CALL_TIMEOUT_MS = 11 * 60_000;

/** One host's side of a switch, whether it is this machine or one across a link. */
export interface HostGateway {
  readonly hostId: HostId;
  readonly kind: "local" | "remote";
  describeSource(payload: DescribeSourcePayload): Promise<SourceProjectDescription>;
  /** Aborting `signal` kills the push; it then rejects with CANCELLED. */
  pushBranch(payload: LinkPushBranchPayload, signal?: AbortSignal): Promise<PushBranchOutcome>;
  environment(): Promise<HostCloneEnvironment>;
  match(payload: FindProjectMatchPayload): Promise<ProjectMatchCandidate[]>;
  checkDestination(payload: CheckDestinationPayload): Promise<DestinationCheck>;
  suggestDestination(payload: SuggestDestinationPayload): Promise<DestinationCheck>;
  /** Starts the clone-and-open operation; follow it with {@link operationStatus}. */
  startClone(payload: CloneAndOpenPayload): Promise<void>;
  operationStatus(opId: string): Promise<OperationOutcome>;
  cancelOperation(opId: string): Promise<boolean>;
  open(payload: OpenOnHostPayload): Promise<HostProjectOpened>;
  checkOut(payload: CheckOutBranchPayload): Promise<HostProjectOpened>;
  createBundle(projectId: string): Promise<{ token: string; size: number }>;
  discardBundle(token: string): Promise<void>;
}

export class LocalHostGateway implements HostGateway {
  readonly kind = "local" as const;

  constructor(
    readonly hostId: HostId,
    readonly service: ProjectAcrossHostsService
  ) {}

  describeSource(payload: DescribeSourcePayload) {
    return this.service.describeSource(payload);
  }
  pushBranch(payload: PushBranchPayload, signal?: AbortSignal) {
    return this.service.pushBranch(payload, signal);
  }
  environment() {
    return this.service.environment();
  }
  match(payload: FindProjectMatchPayload) {
    return this.service.match(payload);
  }
  checkDestination(payload: CheckDestinationPayload) {
    return this.service.checkDestination(payload);
  }
  suggestDestination(payload: SuggestDestinationPayload) {
    return this.service.suggestDestination(payload);
  }
  async startClone(payload: CloneAndOpenPayload): Promise<void> {
    void this.service.cloneAndOpen(payload).catch(() => {});
  }
  async operationStatus(opId: string) {
    return this.service.operationStatus(opId);
  }
  async cancelOperation(opId: string) {
    return this.service.cancelOperation(opId);
  }
  open(payload: OpenOnHostPayload) {
    return this.service.open(payload);
  }
  checkOut(payload: CheckOutBranchPayload) {
    return this.service.checkOut(payload);
  }
  async createBundle(projectId: string) {
    const created = await this.service.createBundle({ projectId });
    return { token: created.token, size: created.size };
  }
  discardBundle(token: string) {
    return this.service.bundles.discard(token);
  }
}

/** Resolves the host's open session, dialing it first when needed. */
export type SessionResolver = (hostId: HostId) => Promise<LinkSession>;

export class RemoteHostGateway implements HostGateway {
  readonly kind = "remote" as const;

  constructor(
    readonly hostId: HostId,
    private readonly resolveSession: SessionResolver
  ) {}

  session(): Promise<LinkSession> {
    return this.resolveSession(this.hostId);
  }

  private async call<T>(
    method: string,
    payload: unknown,
    schema: z.ZodType<T>,
    timeoutMs?: number
  ): Promise<T> {
    const session = await this.session();
    const answer = await session.call(
      method,
      payload,
      timeoutMs === undefined ? {} : { timeoutMs }
    );
    const parsed = schema.safeParse(answer);
    if (!parsed.success) {
      throw new AppError({
        code: "INTERNAL",
        message: `Host ${this.hostId} sent an invalid answer to ${method}`,
      });
    }
    return parsed.data;
  }

  describeSource(payload: DescribeSourcePayload) {
    return this.call(ProjectLinkMethod.DESCRIBE_SOURCE, payload, SourceDescriptionSchema);
  }
  async pushBranch(payload: LinkPushBranchPayload, signal?: AbortSignal) {
    if (signal?.aborted) throw new AppError({ code: "CANCELLED", message: "Push cancelled" });
    const opId = payload.opId;
    const onAbort = () => {
      if (opId === undefined) return;
      void this.session()
        .then((session) => session.call(ProjectLinkMethod.PUSH_CANCEL, { opId }))
        .catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // A push can outlast the default call timeout on a slow link or a large branch.
      return await this.call(
        ProjectLinkMethod.PUSH_BRANCH,
        payload,
        PushOutcomeSchema,
        PUSH_CALL_TIMEOUT_MS
      );
    } catch (error) {
      if (signal?.aborted) throw new AppError({ code: "CANCELLED", message: "Push cancelled" });
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
  environment() {
    return this.call(ProjectLinkMethod.ENVIRONMENT, null, EnvironmentSchema);
  }
  match(payload: FindProjectMatchPayload) {
    return this.call(ProjectLinkMethod.MATCH, payload, CandidatesSchema);
  }
  checkDestination(payload: CheckDestinationPayload) {
    return this.call(ProjectLinkMethod.CHECK_DESTINATION, payload, DestinationSchema);
  }
  suggestDestination(payload: SuggestDestinationPayload) {
    return this.call(ProjectLinkMethod.SUGGEST_DESTINATION, payload, DestinationSchema);
  }
  /**
   * The host clones only into a folder it granted this session, so ask it to
   * check the destination (again, right now) and grant it first.
   */
  async startClone(payload: CloneAndOpenPayload): Promise<void> {
    // One session for both: a grant belongs to the session it was minted on.
    const session = await this.session();
    const parsed = DestinationSchema.safeParse(
      await session.call(ProjectLinkMethod.CHECK_DESTINATION, {
        path: payload.destination,
        remoteUrls: payload.source.kind === "remote" ? [payload.source.url] : [],
        mintGrant: true,
      })
    );
    if (!parsed.success) {
      throw new AppError({
        code: "INTERNAL",
        message: `Host ${this.hostId} sent an invalid answer to ${ProjectLinkMethod.CHECK_DESTINATION}`,
      });
    }
    const check = parsed.data;
    if (check.status !== "free" || !check.grant) {
      const detail = check.detail ?? "That folder can't take the clone.";
      throw new AppError({ code: "VALIDATION", message: detail, userMessage: detail });
    }
    const start: LinkStartClonePayload = { ...payload, destinationGrant: check.grant };
    await session.call(ProjectLinkMethod.START_CLONE, start);
  }
  operationStatus(opId: string) {
    return this.call(ProjectLinkMethod.OPERATION_STATUS, { opId }, OperationOutcomeSchema);
  }
  async cancelOperation(opId: string): Promise<boolean> {
    const session = await this.session();
    return (await session.call(ProjectLinkMethod.OPERATION_CANCEL, { opId })) === true;
  }
  open(payload: OpenOnHostPayload) {
    return this.call(ProjectLinkMethod.OPEN, payload, OpenedSchema, 0);
  }
  checkOut(payload: CheckOutBranchPayload) {
    return this.call(ProjectLinkMethod.CHECK_OUT, payload, OpenedSchema, 0);
  }
  createBundle(projectId: string) {
    return this.call(ProjectLinkMethod.BUNDLE_CREATE, { projectId }, BundleCreatedSchema, 0);
  }
  async discardBundle(token: string): Promise<void> {
    const session = await this.session();
    await session.call(ProjectLinkMethod.BUNDLE_DISCARD, { token });
  }
  async expectBundle(): Promise<string> {
    return (await this.call(ProjectLinkMethod.BUNDLE_EXPECT, null, BundleExpectedSchema)).token;
  }
}

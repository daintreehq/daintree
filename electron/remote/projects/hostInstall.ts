import crypto from "node:crypto";
import path from "node:path";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { getDriveLeaseService } from "../../services/DriveLeaseService.js";
import type { LinkSession } from "../link/session.js";
import { fileTransferSource } from "../link/transfer.js";
import {
  getProjectAcrossHostsService,
  type ProjectAcrossHostsService,
} from "../../services/projectAcrossHosts/index.js";
import { AppError } from "../../utils/errorTypes.js";
import { hostBundleSinkFor } from "./bundleSinks.js";
import {
  BUNDLE_SINK_PREFIX,
  BundleCreateSchema,
  BundleSendSchema,
  BundleTokenSchema,
  CheckDestinationSchema,
  CheckOutSchema,
  DescribeSourceSchema,
  EmptySchema,
  MatchSchema,
  OpIdSchema,
  OpenSchema,
  ProjectLinkMethod,
  PushBranchSchema,
  StartCloneSchema,
  SuggestDestinationSchema,
  type LinkDestinationCheck,
} from "./linkMethods.js";

type BoundEndpoint = Pick<ClientEndpoint, "endpointId" | "clientId">;

/**
 * Who may change a project on this host from a session: the session's own
 * attached views of it, and whether one of them drives it. The Shell is
 * where a person confirms; this is what the host checks for itself.
 */
export interface ProjectsHostAuthority {
  /** Open views of `projectId` that this session itself carries. */
  boundEndpoints(sessionId: string, projectId: string): BoundEndpoint[];
  isDriving(projectId: string, endpoint: BoundEndpoint): boolean;
  /** The endpoint holding the project's drive lease, or null while nobody does. */
  holderEndpointId(projectId: string): string | null;
}

/**
 * Whether `endpointId` is one of this session's views. SessionHost names a
 * remote endpoint `remote:<sessionId>:<clientEndpointId>`; the session id is
 * the host's own, unlike the client id a HELLO merely claims.
 */
export function isSessionEndpoint(sessionId: string, endpointId: string): boolean {
  return endpointId.startsWith(`remote:${sessionId}:`);
}

export const defaultProjectsHostAuthority: ProjectsHostAuthority = {
  boundEndpoints: (sessionId, projectId) =>
    getEndpointRegistry()
      .getForProject(projectId)
      .filter(
        (endpoint) =>
          endpoint.kind === "remote-view" && isSessionEndpoint(sessionId, endpoint.endpointId)
      ),
  isDriving: (projectId, endpoint) => getDriveLeaseService().isDriving(projectId, endpoint),
  holderEndpointId: (projectId) => getDriveLeaseService().getHolder(projectId)?.endpointId ?? null,
};

const GRANT_TTL_MS = 30 * 60_000;
const MAX_GRANTS = 64;

interface DestinationGrant {
  path: string;
  expiresAt: number;
  /** The clone that used it: a resend of that same start is not a second use. */
  usedBy: string | null;
}

/**
 * What this host has proposed to one session: folders it checked as free for
 * a clone, and branches it offered to check out in a project the session has
 * no view of yet. Each is used once; kept by session id so a resumed link
 * still holds them.
 */
export class ProjectHostGrants {
  private readonly destinations = new Map<string, DestinationGrant>();
  private readonly checkouts = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  mintDestination(destination: string): string {
    this.prune();
    const token = crypto.randomBytes(16).toString("hex");
    this.destinations.set(token, {
      path: path.resolve(destination),
      expiresAt: this.now() + GRANT_TTL_MS,
      usedBy: null,
    });
    trim(this.destinations);
    return token;
  }

  /** Spend the grant for `destination` on clone `opId`; false when it isn't this session's to spend. */
  useDestination(token: string | null | undefined, destination: string, opId: string): boolean {
    this.prune();
    const grant = typeof token === "string" ? this.destinations.get(token) : undefined;
    if (!grant || grant.path !== path.resolve(destination)) return false;
    if (grant.usedBy !== null) return grant.usedBy === opId;
    grant.usedBy = opId;
    return true;
  }

  offerCheckout(projectId: string, branch: BranchTarget): void {
    this.prune();
    this.checkouts.set(checkoutKey(projectId, branch), this.now() + GRANT_TTL_MS);
    trim(this.checkouts);
  }

  hasCheckout(projectId: string, branch: BranchTarget): boolean {
    this.prune();
    return this.checkouts.has(checkoutKey(projectId, branch));
  }

  useCheckout(projectId: string, branch: BranchTarget): void {
    this.checkouts.delete(checkoutKey(projectId, branch));
  }

  private prune(): void {
    const now = this.now();
    for (const [token, grant] of this.destinations) {
      if (grant.expiresAt <= now) this.destinations.delete(token);
    }
    for (const [key, expiresAt] of this.checkouts) {
      if (expiresAt <= now) this.checkouts.delete(key);
    }
  }
}

interface BranchTarget {
  name: string;
  remoteBranch: string;
}

function checkoutKey(projectId: string, branch: BranchTarget): string {
  return `${projectId}\0${branch.name}\0${branch.remoteBranch}`;
}

function trim(map: Map<string, unknown>): void {
  while (map.size > MAX_GRANTS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function notAttached(): AppError {
  return new AppError({
    code: "PERMISSION",
    message: "No view of this project is attached from this session",
    userMessage: "Open the project in a window on this host first.",
  });
}

function drivenElsewhere(): AppError {
  return new AppError({
    code: "DRIVEN_ELSEWHERE",
    message: "Another window drives this project",
    userMessage: "Another window is driving this project. Take it over first.",
  });
}

export interface AttachProjectsHostOptions {
  /** The host's id for the session, whose views and lease the mutations are checked against. */
  sessionId?: string | null;
  authority?: ProjectsHostAuthority;
  grants?: ProjectHostGrants;
}

export interface ProjectsHostServer {
  onSession(listener: (ctx: { session: LinkSession; sessionId?: string }) => void): () => void;
  onSessionExpired?(listener: (info: { sessionId: string }) => void): () => void;
}

/**
 * Answer a session's project calls: describe and push a branch when this
 * host is the source, match, clone and open when it is the target, and move
 * bundles either way. Handlers live as long as the session does.
 *
 * A push or a checkout needs a view of the project this session drives (or a
 * checkout this host offered the session when it opened the project); a
 * clone goes only into a folder this host checked and granted the session.
 */
export function attachProjectsHost(
  session: LinkSession,
  service: ProjectAcrossHostsService,
  options: AttachProjectsHostOptions = {}
): void {
  const sessionId = options.sessionId ?? null;
  const authority = options.authority ?? defaultProjectsHostAuthority;
  const grants = options.grants ?? new ProjectHostGrants();
  // Pushes by the opId the Shell cancels them by, plus every running push so
  // the link closing can stop them all.
  const pushes = new Map<string, AbortController>();
  const running = new Set<AbortController>();
  // A push lives only as long as the link that asked for it. Once the link
  // drops, the Shell has already reported the step as not finished and can
  // neither cancel it nor learn how it ended, so it must not go on unseen.
  // Killing git mid-push is safe: the remote updates each ref atomically.
  session.onClose(() => {
    for (const controller of running) controller.abort();
  });

  const boundTo = (projectId: string): BoundEndpoint[] =>
    sessionId === null ? [] : authority.boundEndpoints(sessionId, projectId);
  const requireDriving = (projectId: string, bound: BoundEndpoint[]): void => {
    if (bound.length === 0) throw notAttached();
    if (!bound.some((endpoint) => authority.isDriving(projectId, endpoint))) {
      throw drivenElsewhere();
    }
  };

  const on = session.registerCallHandler.bind(session);
  on(ProjectLinkMethod.DESCRIBE_SOURCE, DescribeSourceSchema, (p) => service.describeSource(p));
  on(ProjectLinkMethod.PUSH_BRANCH, PushBranchSchema, async (p) => {
    requireDriving(p.projectId, boundTo(p.projectId));
    if (!session.isOpen) {
      throw new AppError({ code: "HOST_DISCONNECTED", message: "The link closed" });
    }
    const controller = new AbortController();
    const opId = p.opId;
    if (opId !== undefined) {
      if (pushes.has(opId)) {
        throw new AppError({ code: "VALIDATION", message: "That push is already running" });
      }
      pushes.set(opId, controller);
    }
    running.add(controller);
    try {
      return await service.pushBranch(p, controller.signal);
    } finally {
      running.delete(controller);
      if (opId !== undefined && pushes.get(opId) === controller) pushes.delete(opId);
    }
  });
  on(ProjectLinkMethod.PUSH_CANCEL, OpIdSchema, ({ opId }) => {
    const controller = pushes.get(opId);
    if (!controller) return false;
    controller.abort();
    return true;
  });
  on(ProjectLinkMethod.ENVIRONMENT, EmptySchema, () => service.environment());
  on(ProjectLinkMethod.MATCH, MatchSchema, (p) => service.match(p));
  on(
    ProjectLinkMethod.CHECK_DESTINATION,
    CheckDestinationSchema,
    async (p): Promise<LinkDestinationCheck> => {
      const check = await service.checkDestination(p);
      return p.mintGrant && check.status === "free"
        ? { ...check, grant: grants.mintDestination(check.path) }
        : check;
    }
  );
  on(ProjectLinkMethod.SUGGEST_DESTINATION, SuggestDestinationSchema, (p) =>
    service.suggestDestination(p)
  );
  on(ProjectLinkMethod.START_CLONE, StartCloneSchema, (p) => {
    if (!grants.useDestination(p.destinationGrant, p.destination, p.opId)) {
      throw new AppError({
        code: "PERMISSION",
        message: "The clone destination was not granted to this session",
        userMessage: "Check the folder on this host again, then clone.",
      });
    }
    // Registered synchronously, so a status call right after this answer
    // finds the record; the Shell follows it by opId, surviving a link drop.
    void service.cloneAndOpen(p).catch(() => {});
    return null;
  });
  on(ProjectLinkMethod.OPERATION_STATUS, OpIdSchema, ({ opId }) => service.operationStatus(opId));
  on(ProjectLinkMethod.OPERATION_CANCEL, OpIdSchema, ({ opId }) => service.cancelOperation(opId));
  on(ProjectLinkMethod.OPEN, OpenSchema, async (p) => {
    const opened = await service.open(p);
    if (opened.canCheckOutBranch && p.branch) {
      grants.offerCheckout(opened.projectId, p.branch);
    }
    return opened;
  });
  on(ProjectLinkMethod.CHECK_OUT, CheckOutSchema, async (p) => {
    const bound = boundTo(p.projectId);
    const offered = bound.length === 0 && grants.hasCheckout(p.projectId, p.branch);
    if (offered) {
      const holder = authority.holderEndpointId(p.projectId);
      if (holder !== null && (sessionId === null || !isSessionEndpoint(sessionId, holder))) {
        throw drivenElsewhere();
      }
      grants.useCheckout(p.projectId, p.branch);
    } else {
      requireDriving(p.projectId, bound);
    }
    return service.checkOut(p);
  });
  on(ProjectLinkMethod.BUNDLE_CREATE, BundleCreateSchema, async (p) => {
    const created = await service.createBundle(p);
    return { token: created.token, size: created.size };
  });
  on(ProjectLinkMethod.BUNDLE_EXPECT, EmptySchema, async () => ({
    token: (await service.bundles.expect()).token,
  }));
  on(ProjectLinkMethod.BUNDLE_DISCARD, BundleTokenSchema, async ({ token }) => {
    await service.bundles.discard(token);
    return null;
  });
  on(ProjectLinkMethod.BUNDLE_SEND, BundleSendSchema, async ({ token, sinkToken }) => {
    const entry = service.bundles.get(token);
    if (!entry) throw new AppError({ code: "NOT_FOUND", message: "No such bundle on this host" });
    const source = await fileTransferSource(entry.path);
    try {
      const result = await session.transfers.send(source, {
        name: "repository.bundle",
        destination: { kind: "path", path: `${BUNDLE_SINK_PREFIX}${sinkToken}` },
      });
      return { bytes: result.bytes };
    } finally {
      await source.close?.();
      await service.bundles.discard(token);
    }
  });
  // Beside the upload inbox's provider on the same session, never instead of it.
  session.transfers.addSinkProvider(hostBundleSinkFor(service.bundles, new Set()));
}

/** Host mode: serve project calls on every session the server accepts. */
export function installProjectsHost(
  server: ProjectsHostServer,
  service: ProjectAcrossHostsService = getProjectAcrossHostsService()
): () => void {
  const grantsBySession = new Map<string, ProjectHostGrants>();
  const offSession = server.onSession(({ session, sessionId }) => {
    let grants: ProjectHostGrants | undefined;
    if (sessionId !== undefined) {
      grants = grantsBySession.get(sessionId);
      if (!grants) {
        grants = new ProjectHostGrants();
        grantsBySession.set(sessionId, grants);
      }
    }
    attachProjectsHost(session, service, { sessionId: sessionId ?? null, grants });
  });
  const offExpired = server.onSessionExpired?.(({ sessionId }) => {
    grantsBySession.delete(sessionId);
  });
  return () => {
    offSession();
    offExpired?.();
    grantsBySession.clear();
  };
}

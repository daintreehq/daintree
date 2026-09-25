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
} from "./linkMethods.js";

export interface ProjectsHostServer {
  onSession(listener: (ctx: { session: LinkSession }) => void): () => void;
}

/**
 * Answer a session's project calls: describe and push a branch when this
 * host is the source, match, clone and open when it is the target, and move
 * bundles either way. Handlers live as long as the session does.
 */
export function attachProjectsHost(session: LinkSession, service: ProjectAcrossHostsService): void {
  const on = session.registerCallHandler.bind(session);
  on(ProjectLinkMethod.DESCRIBE_SOURCE, DescribeSourceSchema, (p) => service.describeSource(p));
  on(ProjectLinkMethod.PUSH_BRANCH, PushBranchSchema, (p) => service.pushBranch(p));
  on(ProjectLinkMethod.ENVIRONMENT, EmptySchema, () => service.environment());
  on(ProjectLinkMethod.MATCH, MatchSchema, (p) => service.match(p));
  on(ProjectLinkMethod.CHECK_DESTINATION, CheckDestinationSchema, (p) =>
    service.checkDestination(p)
  );
  on(ProjectLinkMethod.SUGGEST_DESTINATION, SuggestDestinationSchema, (p) =>
    service.suggestDestination(p)
  );
  on(ProjectLinkMethod.START_CLONE, StartCloneSchema, (p) => {
    // Registered synchronously, so a status call right after this answer
    // finds the record; the Shell follows it by opId, surviving a link drop.
    void service.cloneAndOpen(p).catch(() => {});
    return null;
  });
  on(ProjectLinkMethod.OPERATION_STATUS, OpIdSchema, ({ opId }) => service.operationStatus(opId));
  on(ProjectLinkMethod.OPERATION_CANCEL, OpIdSchema, ({ opId }) => service.cancelOperation(opId));
  on(ProjectLinkMethod.OPEN, OpenSchema, (p) => service.open(p));
  on(ProjectLinkMethod.CHECK_OUT, CheckOutSchema, (p) => service.checkOut(p));
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
  return server.onSession(({ session }) => attachProjectsHost(session, service));
}

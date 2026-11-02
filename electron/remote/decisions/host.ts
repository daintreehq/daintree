import type {
  HostAcceptResult,
  HostIdentityReport,
  HostRequestResult,
} from "../../types/decisionsHosts.js";
import type { LinkSession } from "../link/session.js";
import {
  DecisionsLinkMethod,
  EnrollHostPayloadSchema,
  HostAcceptResultSchema,
  HostRequestResultSchema,
  HostStatusResultSchema,
  type EnrollHostPayload,
  type HostStatusResult,
} from "./linkMethods.js";

/** One attached Shell's session; the session itself is what pending keys are bound to. */
export interface DecisionsSessionContext {
  session: LinkSession;
}

export interface DecisionsSessionSource {
  readonly sessions: ReadonlyArray<DecisionsSessionContext>;
  onSession(listener: (ctx: DecisionsSessionContext) => void): () => void;
}

/**
 * This Host's enrollment as a Decisions device, loaded on the first CALL. The
 * `link` each step names is the session it came over: keys made for one
 * session are accepted only on that session.
 */
export interface DecisionsHostEnrollment {
  status(): Promise<HostIdentityReport>;
  request(
    link: object,
    input: { attempt: string; label: string; replace?: string }
  ): Promise<HostRequestResult>;
  accept(link: object, input: { attempt: string; response: string }): Promise<HostAcceptResult>;
  /** The session closed: the keys it was given and never accepted are dropped. */
  forget(link: object): void;
  dispose(): Promise<void>;
}

type Answer = HostStatusResult | HostRequestResult | HostAcceptResult;

/**
 * Host side of enrollment (#16021): every attached Shell's session can ask,
 * and only the owner's will, since only it can sign an enrollment. Nothing
 * of Decisions loads until a Shell first asks; the keys are made, checked and
 * sealed here, and only their public halves are ever answered.
 */
export function installDecisionsHostWith(
  server: DecisionsSessionSource,
  load: () => Promise<DecisionsHostEnrollment>
): () => void {
  let loading: Promise<DecisionsHostEnrollment> | null = null;
  let loaded: DecisionsHostEnrollment | null = null;
  let disposed = false;
  const wired = new WeakSet<LinkSession>();
  const unregisters = new Set<() => void>();

  const enrollment = (): Promise<DecisionsHostEnrollment> => {
    loading ??= load().then((made) => {
      loaded = made;
      if (disposed) void made.dispose();
      return made;
    });
    // A failed load is tried again by the next CALL.
    loading.catch(() => {
      if (loaded === null) loading = null;
    });
    return loading;
  };

  const answer = async (session: LinkSession, payload: EnrollHostPayload): Promise<Answer> => {
    const made = await enrollment();
    if (disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    switch (payload.step) {
      case "status":
        return HostStatusResultSchema.parse({ step: "status", identity: await made.status() });
      case "request":
        return HostRequestResultSchema.parse(
          await made.request(session, {
            attempt: payload.attempt,
            label: payload.label,
            ...(payload.replace !== undefined ? { replace: payload.replace } : {}),
          })
        );
      case "accept":
        return HostAcceptResultSchema.parse(
          await made.accept(session, { attempt: payload.attempt, response: payload.response })
        );
    }
  };

  const wire = ({ session }: DecisionsSessionContext): void => {
    if (disposed || wired.has(session)) return;
    wired.add(session);
    const offCall = session.registerCallHandler(
      DecisionsLinkMethod.ENROLL_HOST,
      EnrollHostPayloadSchema,
      (payload) => answer(session, payload)
    );
    let offClose: () => void = () => {};
    const unregister = () => {
      offCall();
      offClose();
      unregisters.delete(unregister);
      loaded?.forget(session);
    };
    unregisters.add(unregister);
    offClose = session.onClose(unregister);
  };

  for (const ctx of server.sessions) wire(ctx);
  const offSession = server.onSession(wire);
  return () => {
    disposed = true;
    offSession();
    for (const unregister of [...unregisters]) unregister();
    void loaded?.dispose();
  };
}

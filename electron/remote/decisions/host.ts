import type { DecisionsHostRuntime } from "../../../shared/types/decisionsHosts.js";
import type {
  HeldHost,
  HostAcceptResult,
  HostIdentityReport,
  HostRequestResult,
  OwnerStateAnnouncement,
} from "../../types/decisionsHosts.js";
import type { LinkSession } from "../link/session.js";
import {
  DecisionsLinkMethod,
  EnrollHostPayloadSchema,
  HostAcceptResultSchema,
  HostRequestResultSchema,
  HostRuntimeSchema,
  HostStatusResultSchema,
  OwnerStatePayloadSchema,
  type EnrollHostPayload,
  type HostRuntimePayload,
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

type OwnerOf = Pick<OwnerStateAnnouncement, "installationId" | "ownerDeviceId">;

/** This Host's own Decisions (#16022), once loaded. */
export interface DecisionsHostLifetime {
  /** Applies what the owner's Shell said, and answers what the Host then reports to it. */
  apply(state: OwnerStateAnnouncement): Promise<DecisionsHostRuntime>;
  /**
   * The key file holds `held`, just accepted or read: what this Host runs as,
   * off from the start if its owner's Shell last said so (`ownerEnabled`).
   */
  adopt(held: HeldHost, ownerEnabled: boolean | undefined): Promise<void>;
  /** What the Host reports to `owner` now. */
  reportFor(owner: OwnerOf): DecisionsHostRuntime;
  /** Called whenever what it reports may have changed. */
  onChanged(listener: () => void): () => void;
}

/** How the link reaches this Host's own Decisions, loading nothing until it must. */
export interface DecisionsHostRuntimeSource {
  /** The saved record names an enrollment by `owner`; read without loading anything. */
  enrolledBy(owner: OwnerOf): boolean;
  load(): Promise<DecisionsHostLifetime>;
}

/**
 * Host side of enrollment (#16021): every attached Shell's session can ask,
 * and only the owner's will, since only it can sign an enrollment. Nothing
 * of Decisions loads until a Shell first asks; the keys are made, checked and
 * sealed here, and only their public halves are ever answered.
 *
 * With `runtime`, the owner's Shell also says whether its Decisions is on
 * (#16022), which turns this Host's own off or on, and hears what the Host
 * reports of it whenever that changes. An owner that never enrolled this
 * Host loads nothing.
 */
export function installDecisionsHostWith(
  server: DecisionsSessionSource,
  load: (onHeld: (held: HeldHost) => void) => Promise<DecisionsHostEnrollment>,
  runtime?: DecisionsHostRuntimeSource
): () => Promise<void> {
  let loading: Promise<DecisionsHostEnrollment> | null = null;
  let loaded: DecisionsHostEnrollment | null = null;
  let disposed = false;
  const wired = new WeakSet<LinkSession>();
  const unregisters = new Set<() => void>();
  /** The owner each session last announced (#16022): only those sessions hear the Host's reports. */
  const owners = new Map<LinkSession, OwnerStateAnnouncement>();
  /** What each session was last told, so a report it already has isn't sent again. */
  const told = new Map<LinkSession, string>();
  /** What each owner's Shells last said, by owner: an enrollment taken up later starts as it says. */
  const latestByOwner = new Map<string, boolean>();
  const ownerKey = (owner: OwnerOf) => `${owner.installationId}\n${owner.ownerDeviceId}`;
  let lifetime: Promise<DecisionsHostLifetime> | null = null;
  let offChanged: (() => void) | null = null;

  const tell = (session: LinkSession, report: DecisionsHostRuntime): void => {
    const key = JSON.stringify(report);
    if (told.get(session) === key || !session.isOpen) return;
    told.set(session, key);
    const payload: HostRuntimePayload = { runtime: HostRuntimeSchema.parse(report) };
    // A Shell from before reports were pushed answers UNSUPPORTED; its next announcement reads it.
    session.call(DecisionsLinkMethod.HOST_RUNTIME, payload).catch(() => {});
  };

  const tellOwners = (made: DecisionsHostLifetime): void => {
    if (disposed) return;
    for (const [session, owner] of owners) tell(session, made.reportFor(owner));
  };

  /** Loads the Host's Decisions and follows what it reports, once. */
  const followLifetime = (): Promise<DecisionsHostLifetime> | null => {
    if (!runtime || disposed) return null;
    if (!lifetime) {
      const made = runtime.load().then((loadedLifetime) => {
        if (!disposed && offChanged === null) {
          offChanged = loadedLifetime.onChanged(() => tellOwners(loadedLifetime));
          // Sessions told "not enrolled" before an enrollment hear what it is now.
          tellOwners(loadedLifetime);
        }
        return loadedLifetime;
      });
      lifetime = made;
      // A failed load is tried again by the next announcement.
      made.catch(() => {
        if (lifetime === made) lifetime = null;
      });
    }
    return lifetime;
  };

  const announced = async (
    session: LinkSession,
    state: OwnerStateAnnouncement
  ): Promise<{ runtime: DecisionsHostRuntime }> => {
    if (disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    owners.set(session, state);
    latestByOwner.set(ownerKey(state), state.enabled);
    // An owner that never enrolled this Host loads nothing of Decisions here.
    if (!runtime?.enrolledBy(state)) {
      const none: DecisionsHostRuntime = { state: "not-enrolled" };
      told.set(session, JSON.stringify(none));
      return { runtime: none };
    }
    const made = await followLifetime();
    if (!made) throw new Error("This Host stopped serving Shells");
    const report = await made.apply(state);
    // A session that closed, or announced again, meanwhile keeps no record of this answer.
    if (!disposed && session.isOpen && owners.get(session) === state) {
      told.set(session, JSON.stringify(report));
    }
    return { runtime: HostRuntimeSchema.parse(report) };
  };

  /** Adoptions still running: stopping waits for them, so none outlives this installer. */
  const adoptions = new Set<Promise<void>>();

  /**
   * The key file holds `held`: its lifetime takes it up, as its owner last
   * said. What the owner said is read once the lifetime has loaded, and its
   * latest word is applied again after: an announcement that came while
   * there was no record yet was only remembered.
   */
  const onHeld = (held: HeldHost): void => {
    const made = followLifetime();
    if (!made) return;
    const key = ownerKey(held);
    const adoption = made
      .then(async (lifetimeOf) => {
        if (disposed) return;
        await lifetimeOf.adopt(held, latestByOwner.get(key));
        // Once taken up, the owner's latest word follows, even if this installer stopped meanwhile.
        const enabled = latestByOwner.get(key);
        if (enabled === undefined) return;
        await lifetimeOf.apply({
          installationId: held.installationId,
          ownerDeviceId: held.ownerDeviceId,
          enabled,
        });
      })
      .catch((err: unknown) => {
        console.warn("[Decisions] This Host's enrollment couldn't be taken up:", err);
      });
    adoptions.add(adoption);
    void adoption.finally(() => adoptions.delete(adoption));
  };

  const enrollment = (): Promise<DecisionsHostEnrollment> => {
    loading ??= load(onHeld).then((made) => {
      loaded = made;
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
    const offOwnerState = runtime
      ? session.registerCallHandler(
          DecisionsLinkMethod.OWNER_STATE,
          OwnerStatePayloadSchema,
          (payload) => announced(session, payload)
        )
      : () => {};
    let offClose: () => void = () => {};
    const unregister = () => {
      offCall();
      offOwnerState();
      offClose();
      unregisters.delete(unregister);
      owners.delete(session);
      told.delete(session);
      loaded?.forget(session);
    };
    unregisters.add(unregister);
    offClose = session.onClose(unregister);
  };

  for (const ctx of server.sessions) wire(ctx);
  const offSession = server.onSession(wire);
  // Resolves once a step already under way has finished, so a listener
  // started again never has two enrollments writing the same key file.
  return async () => {
    disposed = true;
    offSession();
    offChanged?.();
    offChanged = null;
    for (const unregister of [...unregisters]) unregister();
    const made = loaded ?? (loading ? await loading.catch(() => null) : null);
    await made?.dispose();
    await Promise.all([...adoptions]);
  };
}

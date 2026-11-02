import { store } from "../../store.js";
import { loadDecisionsModule } from "../../window/serviceRefs.js";
import { installDecisionsHostWith, type DecisionsSessionSource } from "./host.js";

function decisionsModule() {
  const loading = loadDecisionsModule(() => import("../../services/decisions/index.js"));
  if (loading === null) return Promise.reject(new Error("Decisions has stopped for this run"));
  return loading;
}

/**
 * Lets the Decisions owner among this host's Shells enroll it as a device
 * (#16021), and turn its own Decisions off and on (#16022). Decisions' own
 * modules load on the first CALL that needs them, never before: an owner
 * that never enrolled this Host loads nothing.
 */
export function installDecisionsHost(server: DecisionsSessionSource): () => Promise<void> {
  return installDecisionsHostWith(
    server,
    async (onHeld) => {
      const { HostEnrollments } = await import("../../services/decisions/hostEnrollmentHost.js");
      return new HostEnrollments({ onHeld });
    },
    {
      enrolledBy: (owner) => {
        const record = store.get("decisionsHost");
        return (
          record?.installationId === owner.installationId &&
          record.ownerDeviceId === owner.ownerDeviceId
        );
      },
      load: async () => {
        const decisions = await decisionsModule();
        return {
          apply: (state) => decisions.applyOwnerState(state),
          adopt: (held, ownerEnabled) =>
            decisions.noteHostIdentity(held, ownerEnabled === undefined ? {} : { ownerEnabled }),
          reportFor: (owner) => decisions.decisionsHostRuntimeFor(owner),
          onChanged: (listener) => decisions.onDecisionsHostRuntimeChanged(listener),
        };
      },
    }
  );
}

import { useEffect, useState } from "react";
import { connectivityClient } from "@/clients/connectivityClient";
import type {
  ConnectivityServiceKey,
  ServiceConnectivityPayload,
  ServiceConnectivitySnapshot,
  ServiceConnectivityStatus,
} from "@shared/types";
import { CONNECTIVITY_SERVICE_KEYS } from "@shared/types";

function buildInitialSnapshot(): ServiceConnectivitySnapshot {
  return Object.fromEntries(
    CONNECTIVITY_SERVICE_KEYS.map((key) => [
      key,
      { serviceKey: key, status: "unknown" as ServiceConnectivityStatus, checkedAt: 0 },
    ])
  ) as ServiceConnectivitySnapshot;
}

/**
 * Subscribes to per-service connectivity health pushed from the main process.
 *
 * Mount-time hydration is mandatory: each `WebContentsView` has an isolated
 * Zustand store, so a window that mounts after the initial probes settled
 * would never receive the current state through push events alone. The
 * `cancelled` guard prevents a late-arriving `getState()` from clobbering a
 * push event that landed first on a slow main-process round trip.
 */
export function useConnectivitySnapshot(): ServiceConnectivitySnapshot {
  const [snapshot, setSnapshot] = useState<ServiceConnectivitySnapshot>(buildInitialSnapshot);

  useEffect(() => {
    let cancelled = false;

    const applyDelta = (payload: ServiceConnectivityPayload) => {
      if (cancelled) return;
      setSnapshot((prev) => {
        const existing = prev[payload.serviceKey];
        if (existing.status === payload.status && existing.checkedAt === payload.checkedAt) {
          return prev;
        }
        return { ...prev, [payload.serviceKey]: payload };
      });
    };

    const cleanup = connectivityClient.onServiceChanged(applyDelta);

    void connectivityClient
      .getState()
      .then((next) => {
        if (cancelled) return;
        setSnapshot((prev) => {
          // Preserve any payload that arrived via push after we issued the
          // mount-time getState() — push events represent newer truth. Use
          // `>=` so push-delivered status wins on `checkedAt` ties; the
          // alternative ('>') drops a same-millisecond push update if
          // getState() resolves later with stale data.
          const merged = { ...next };
          for (const key of CONNECTIVITY_SERVICE_KEYS) {
            if (prev[key].checkedAt >= merged[key].checkedAt && prev[key].checkedAt > 0) {
              merged[key] = prev[key];
            }
          }
          return merged;
        });
      })
      .catch(() => {
        // Initial-state fetch is best-effort; transitions still work.
      });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  return snapshot;
}

/**
 * Reactive accessor for a single service's connectivity. Backed by the same
 * subscription as {@link useConnectivitySnapshot} but only returns the slice
 * for the requested service key.
 */
export function useConnectivity(serviceKey: ConnectivityServiceKey): ServiceConnectivityPayload {
  const snapshot = useConnectivitySnapshot();
  return snapshot[serviceKey];
}

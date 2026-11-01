import { useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsDevice } from "@shared/types/decisions";
import { describeRevokeResult, describeRotateResult } from "./devicesCopy";

/** The latest change to the key, or why one didn't finish, in words. */
export interface DecisionsKeyNotice {
  message: string;
  problem: boolean;
}

export interface UseDecisionsKeyActionsResult {
  /** The action running; only one at a time. */
  pending: "revoke" | "rotate" | null;
  /** What the latest revocation or rotation came to; null until one is made. */
  notice: DecisionsKeyNotice | null;
  /** Why the revocation being confirmed didn't finish; shown in its dialog. */
  revokeError: string | null;
  /** Resolves true when the device needs nothing more (revoked, or no longer listed). */
  revoke(device: DecisionsDevice): Promise<boolean>;
  rotate(): void;
  clearRevokeError(): void;
}

/**
 * Revoking a paired device and rotating the key (#16010), through main. Each
 * outcome is said as it was observed; `onChanged` runs after any that may
 * have changed the relay's devices, so the list is read again.
 */
export function useDecisionsKeyActions(onChanged: () => void): UseDecisionsKeyActionsResult {
  const [pending, setPending] = useState<"revoke" | "rotate" | null>(null);
  const [notice, setNotice] = useState<DecisionsKeyNotice | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const revoke = async (device: DecisionsDevice): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setPending("revoke");
    setRevokeError(null);
    try {
      const result = await window.electron.decisions.revokeDevice(device.deviceId);
      if (!mounted.current) return false;
      const described = describeRevokeResult(result, device.label);
      if (described.finished) setNotice({ message: described.message, problem: false });
      else setRevokeError(described.message);
      onChanged();
      return described.finished;
    } catch (error) {
      if (mounted.current) {
        setRevokeError(formatErrorMessage(error, `'${device.label}' couldn't be revoked.`));
      }
      return false;
    } finally {
      running.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const rotate = () => {
    if (running.current) return;
    running.current = true;
    setPending("rotate");
    setNotice(null);
    window.electron.decisions
      .rotateKeys()
      .then(
        (result) => {
          if (!mounted.current) return;
          const described = describeRotateResult(result);
          setNotice({ message: described.message, problem: !described.finished });
          onChanged();
        },
        (error: unknown) => {
          if (!mounted.current) return;
          setNotice({
            message: formatErrorMessage(error, "The key couldn't be rotated."),
            problem: true,
          });
        }
      )
      .finally(() => {
        running.current = false;
        if (mounted.current) setPending(null);
      });
  };

  return {
    pending,
    notice,
    revokeError,
    revoke,
    rotate,
    clearRevokeError: () => setRevokeError(null),
  };
}

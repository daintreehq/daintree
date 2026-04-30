import { useCallback, useEffect, useRef, useState } from "react";
import { systemClient } from "@/clients";
import type { PrerequisiteCheckResult, PrerequisiteSpec } from "@shared/types";
import { formatErrorMessage } from "@shared/utils/errorMessage";

const POOL_CONCURRENCY = 3;

export type CheckState = "loading" | PrerequisiteCheckResult;

export async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const iter = items[Symbol.iterator]();
  async function worker() {
    for (let next = iter.next(); !next.done; next = iter.next()) {
      await fn(next.value);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

export interface SystemHealthCheckState {
  specs: PrerequisiteSpec[];
  checkStates: Record<string, CheckState>;
  isChecking: boolean;
  error: string | null;
  visibleSpecs: PrerequisiteSpec[];
  allDone: boolean;
  hasFatalFailure: boolean;
  runCheck: () => Promise<void>;
}

export function useSystemHealthCheck(): SystemHealthCheckState {
  const [specs, setSpecs] = useState<PrerequisiteSpec[]>([]);
  const [checkStates, setCheckStates] = useState<Record<string, CheckState>>({});
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(true);
  const isCheckingRef = useRef(false);

  const runCheck = useCallback(async () => {
    if (isCheckingRef.current) return;
    isCheckingRef.current = true;
    setIsChecking(true);
    setError(null);
    setSpecs([]);
    setCheckStates({});

    try {
      const resolvedSpecs = await systemClient.getHealthCheckSpecs();
      if (!activeRef.current) return;

      setSpecs(resolvedSpecs);
      setCheckStates(Object.fromEntries(resolvedSpecs.map((s) => [s.tool, "loading" as const])));

      await runPool(resolvedSpecs, POOL_CONCURRENCY, async (spec) => {
        try {
          const result = await systemClient.checkTool(spec);
          if (activeRef.current) {
            setCheckStates((prev) => ({ ...prev, [spec.tool]: result }));
          }
        } catch {
          if (activeRef.current) {
            setCheckStates((prev) => ({
              ...prev,
              [spec.tool]: {
                tool: spec.tool,
                label: spec.label,
                available: false,
                version: null,
                severity: spec.severity,
                meetsMinVersion: false,
                minVersion: spec.minVersion,
                installUrl: spec.installUrl,
                installBlocks: spec.installBlocks,
              },
            }));
          }
        }
      });
    } catch (err) {
      if (activeRef.current) setError(formatErrorMessage(err, "Health check failed"));
    } finally {
      isCheckingRef.current = false;
      if (activeRef.current) setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void runCheck();
    return () => {
      activeRef.current = false;
    };
  }, [runCheck]);

  const visibleSpecs = specs.filter((s) => s.severity !== "silent");

  const allDone =
    !isChecking &&
    (visibleSpecs.length === 0 || visibleSpecs.every((s) => checkStates[s.tool] !== "loading"));

  const hasFatalFailure = allDone
    ? !visibleSpecs
        .filter((s) => s.severity === "fatal")
        .every((s) => {
          const state = checkStates[s.tool];
          return state !== "loading" && state?.available && state.meetsMinVersion;
        })
    : false;

  return {
    specs,
    checkStates,
    isChecking,
    error,
    visibleSpecs,
    allDone,
    hasFatalFailure,
    runCheck,
  };
}

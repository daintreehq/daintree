import { useEffect, useRef, useState } from "react";
import { filesClient } from "@/clients/filesClient";
import type { FileReadErrorCode } from "@shared/types/ipc/files";

type PlanContentStatus = "idle" | "loading" | "loaded" | "error";

interface UsePlanFileContentResult {
  status: PlanContentStatus;
  content: string | null;
  errorCode: FileReadErrorCode | null;
}

const POLL_INTERVAL_MS = 2000;

export function usePlanFileContent(
  isOpen: boolean,
  filePath: string | undefined,
  rootPath: string,
  pollIntervalMs: number = POLL_INTERVAL_MS
): UsePlanFileContentResult {
  const [status, setStatus] = useState<PlanContentStatus>("idle");
  const [content, setContent] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<FileReadErrorCode | null>(null);
  const requestRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isOpen || !filePath) {
      requestRef.current++; // invalidate any in-flight request
      setStatus("idle");
      setContent(null);
      setErrorCode(null);
      return;
    }

    const absolutePath = filePath.startsWith("/") ? filePath : `${rootPath}/${filePath}`;

    const fetchContent = async () => {
      const requestId = ++requestRef.current;
      if (!isMountedRef.current) return;

      try {
        const result = await filesClient.read({ path: absolutePath, rootPath });
        if (!isMountedRef.current || requestRef.current !== requestId) return;

        if (result.ok) {
          setContent(result.content);
          setStatus("loaded");
          setErrorCode(null);
        } else {
          setErrorCode(result.code);
          setStatus("error");
          setContent(null);
        }
      } catch {
        if (!isMountedRef.current || requestRef.current !== requestId) return;
        setErrorCode("INVALID_PATH");
        setStatus("error");
        setContent(null);
      }
    };

    setStatus("loading");
    void fetchContent();

    const intervalId = setInterval(() => void fetchContent(), pollIntervalMs);
    return () => clearInterval(intervalId);
  }, [isOpen, filePath, rootPath, pollIntervalMs]);

  return { status, content, errorCode };
}

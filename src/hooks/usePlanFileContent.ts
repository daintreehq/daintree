import { useEffect, useRef, useState } from "react";
import { filesClient } from "@/clients/filesClient";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import { isClientAppError } from "@/utils/clientAppError";

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
        const { content: fileContent } = await filesClient.read({
          path: absolutePath,
          rootPath,
        });
        if (!isMountedRef.current || requestRef.current !== requestId) return;

        setContent(fileContent);
        setStatus("loaded");
        setErrorCode(null);
      } catch (error) {
        if (!isMountedRef.current || requestRef.current !== requestId) return;
        const code = isClientAppError(error) ? (error.code as FileReadErrorCode) : "INVALID_PATH";
        setErrorCode(code);
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

import { useEffect } from "react";
import { useUpdateStore } from "@/store/updateStore";

export function useUpdateListener(): void {
  const setAvailable = useUpdateStore((state) => state.setAvailable);
  const setDownloading = useUpdateStore((state) => state.setDownloading);
  const setDownloaded = useUpdateStore((state) => state.setDownloaded);
  useEffect(() => {
    if (!window.electron?.update) return;

    const cleanupAvailable = window.electron.update.onUpdateAvailable((info) => {
      setAvailable(info.version);
    });

    const cleanupProgress = window.electron.update.onDownloadProgress((info) => {
      setDownloading(info.percent);
    });

    const cleanupDownloaded = window.electron.update.onUpdateDownloaded((info) => {
      setDownloaded(info.version);
    });

    return () => {
      cleanupAvailable();
      cleanupProgress();
      cleanupDownloaded();
    };
  }, [setAvailable, setDownloading, setDownloaded]);
}

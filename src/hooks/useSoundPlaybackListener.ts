import { useEffect } from "react";
import { playSound, cancelSound, dispose } from "@/services/WebAudioService";

export function useSoundPlaybackListener(): void {
  useEffect(() => {
    if (!window.electron?.sound) return;

    const cleanupTrigger = window.electron.sound.onTrigger(({ soundFile, detune }) => {
      playSound(soundFile, detune);
    });

    const cleanupCancel = window.electron.sound.onCancel(() => {
      cancelSound();
    });

    return () => {
      cleanupTrigger();
      cleanupCancel();
      dispose();
    };
  }, []);
}

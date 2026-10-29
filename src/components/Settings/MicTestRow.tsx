import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsRow } from "./SettingsGroup";
import {
  MAX_TEST_MS,
  startMicTest,
  type MicTestEndReason,
  type MicTestHandle,
  type MicTestOpened,
  type MicTestSample,
} from "@/services/voiceMicTest";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import type { VoiceInputStatus, VoiceSessionElsewhere } from "@shared/types";

type TestState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running"; opened: MicTestOpened; sample: MicTestSample }
  /** Stopped on its own, not by the user: the outcome stays until the next test. */
  | { phase: "ended"; reason: MicTestEndReason }
  | { phase: "failed"; reason: "denied" | "unavailable" };

/**
 * A dictation that would hear the test, here or in another view: "open" while
 * it can still be stopped, "finishing" while its last words drain. A paused one
 * counts, since its key can resume it mid-test (#14951).
 */
type DictationBlock = "open" | "finishing" | null;

interface DictationState {
  status: VoiceInputStatus;
  pendingTarget: unknown;
  sessionElsewhere: VoiceSessionElsewhere | null;
}

function ownDictationBlock({ status, pendingTarget }: DictationState): DictationBlock {
  if (status === "finishing" && !pendingTarget) return "finishing";
  return pendingTarget || (status !== "idle" && status !== "error") ? "open" : null;
}

function dictationBlock(state: DictationState): DictationBlock {
  const own = ownDictationBlock(state);
  const elsewhere = state.sessionElsewhere;
  if (own === "open" || (elsewhere && elsewhere.details?.phase !== "finishing")) return "open";
  return own ?? (elsewhere ? "finishing" : null);
}

function stopDictation() {
  const state = useVoiceRecordingStore.getState();
  if (ownDictationBlock(state) === "open") {
    void voiceRecordingService.stopActiveSession({ returnToTarget: false });
  } else if (state.sessionElsewhere) {
    void voiceRecordingService.stopSessionElsewhereById(state.sessionElsewhere.sessionId);
  }
}

interface MicTestRowProps {
  /** The saved input device; empty for the system default. */
  deviceId: string;
  /** The name saved with it. */
  deviceLabel?: string;
  /**
   * False while the page is hidden. Settings keeps visited pages mounted, so
   * this, not unmounting, is what lets go of the mic on a page switch.
   */
  active?: boolean;
  disabled?: boolean;
  /** Why the test can't run while `disabled`, shown under the row. */
  disabledReason?: ReactNode;
}

function describe(state: TestState, block: DictationBlock): string {
  if (block === "open") {
    return "A dictation is still open, so what you say could land in its draft. Stop it to test the microphone.";
  }
  if (block === "finishing")
    return "Dictation is finishing. You can test the microphone once it ends.";
  switch (state.phase) {
    case "idle":
      return "Check that the selected microphone is picking you up. Nothing is recorded or sent anywhere.";
    case "starting":
      return "Opening the microphone…";
    case "ended":
      return state.reason === "time-limit"
        ? `Test stopped after ${Math.round(MAX_TEST_MS / 1000)} seconds.`
        : "The microphone stopped sending sound, so the test ended. Check it's still connected, then test again.";
    case "failed":
      return state.reason === "denied"
        ? "Microphone access is blocked, so the test can't listen. Allow it above, then try again."
        : "Couldn't open a microphone. Check one is connected and not in use, then try again.";
    case "running": {
      const { opened, sample } = state;
      const instead = opened.substituted
        ? `The selected microphone wasn't available, so this is testing ${opened.label} instead`
        : null;
      if (sample.silent) {
        const advice = opened.bluetooth
          ? `No sound from ${opened.label}. Bluetooth headsets can go quiet while they switch modes. Wait a moment and speak again, or pick the built-in microphone.`
          : `No sound from ${opened.label}. Check it isn't muted, or pick another microphone.`;
        return instead ? `${instead}. ${advice}` : advice;
      }
      if (instead) return instead;
      return sample.heardSound
        ? `Hearing ${opened.label}`
        : `Listening to ${opened.label}. Say something.`;
    }
  }
}

export function MicTestRow({
  deviceId,
  deviceLabel,
  active = true,
  disabled,
  disabledReason,
}: MicTestRowProps) {
  const [state, setState] = useState<TestState>({ phase: "idle" });
  const block = useVoiceRecordingStore(dictationBlock);
  const handleRef = useRef<MicTestHandle | null>(null);
  // Bumped on every start and stop, so a start that resolves after the user
  // stopped (or after unmount) releases its stream instead of keeping it open.
  const runRef = useRef(0);

  const stop = useCallback(() => {
    runRef.current++;
    handleRef.current?.stop();
    handleRef.current = null;
    setState({ phase: "idle" });
  }, []);

  const start = useCallback(async () => {
    // The button can trail the store by a render.
    if (dictationBlock(useVoiceRecordingStore.getState())) return;
    const run = ++runRef.current;
    handleRef.current?.stop();
    handleRef.current = null;
    setState({ phase: "starting" });
    try {
      const handle = await startMicTest({
        deviceId,
        deviceLabel,
        isCurrent: () =>
          run === runRef.current && !dictationBlock(useVoiceRecordingStore.getState()),
        onSample: (sample) => {
          if (run !== runRef.current) return;
          setState((prev) => (prev.phase === "running" ? { ...prev, sample } : prev));
        },
        onEnded: (reason) => {
          if (run !== runRef.current) return;
          handleRef.current = null;
          setState({ phase: "ended", reason });
        },
      });
      if (run !== runRef.current) {
        handle.stop();
        return;
      }
      handleRef.current = handle;
      setState({
        phase: "running",
        opened: handle.opened,
        sample: { level: 0, heardSound: false, silent: false },
      });
    } catch (reason) {
      if (run !== runRef.current) return;
      setState({ phase: "failed", reason: reason === "denied" ? "denied" : "unavailable" });
    }
  }, [deviceId, deviceLabel]);

  // A test belongs to the device it was started on, and never outlives the page:
  // unmounting or hiding it (another settings page, a search) stops the test.
  // A dictation starting, here or in another view, stops it too.
  useEffect(() => {
    if (!active || block) return;
    return stop;
  }, [stop, active, deviceId, block]);

  const running = state.phase === "running";
  const level = running ? state.sample.level : 0;
  const warn = running && (state.sample.silent || state.opened.substituted);

  return (
    <SettingsRow
      id="voice-mic-test"
      label="Test microphone"
      layout="stacked"
      description={
        <>
          <span role="status">{describe(state, block)}</span>
          {block === "open" && (
            <>
              {" "}
              <Button variant="link" onClick={stopDictation}>
                Stop dictation
              </Button>
            </>
          )}
        </>
      }
      disabled={disabled}
      disabledReason={disabledReason}
      control={({ disabled: rowDisabled, descriptionId }) => (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            onClick={running ? stop : () => void start()}
            loading={state.phase === "starting"}
            // A running test can always be stopped, so the mic is never held
            // open by a row that became disabled mid-test.
            disabled={(rowDisabled || block !== null) && !running}
            aria-describedby={descriptionId}
          >
            {running ? "Stop test" : "Test microphone"}
          </Button>
          <div
            role="meter"
            aria-label="Microphone level"
            aria-describedby={descriptionId}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(level * 100)}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-overlay-medium"
          >
            <div
              className={cn(
                "h-full rounded-full",
                warn ? "bg-status-warning" : "bg-text-secondary"
              )}
              style={{ width: `${level * 100}%` }}
            />
          </div>
        </div>
      )}
    />
  );
}

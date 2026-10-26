import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsRow } from "./SettingsGroup";
import {
  startMicTest,
  type MicTestHandle,
  type MicTestOpened,
  type MicTestSample,
} from "@/services/voiceMicTest";

type TestState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running"; opened: MicTestOpened; sample: MicTestSample }
  | { phase: "failed"; reason: "denied" | "unavailable" };

interface MicTestRowProps {
  /** The saved input device; empty for the system default. */
  deviceId: string;
  /**
   * False while the page is hidden. Settings keeps visited pages mounted, so
   * this, not unmounting, is what lets go of the mic on a page switch.
   */
  active?: boolean;
  disabled?: boolean;
}

function describe(state: TestState): string {
  switch (state.phase) {
    case "idle":
      return "Check that the selected microphone is picking you up. Nothing is recorded or sent anywhere.";
    case "starting":
      return "Opening the microphone…";
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

export function MicTestRow({ deviceId, active = true, disabled }: MicTestRowProps) {
  const [state, setState] = useState<TestState>({ phase: "idle" });
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
    const run = ++runRef.current;
    handleRef.current?.stop();
    handleRef.current = null;
    setState({ phase: "starting" });
    try {
      const handle = await startMicTest({
        deviceId,
        onSample: (sample) => {
          if (run !== runRef.current) return;
          setState((prev) => (prev.phase === "running" ? { ...prev, sample } : prev));
        },
        onEnded: () => {
          if (run !== runRef.current) return;
          handleRef.current = null;
          setState({ phase: "idle" });
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
  }, [deviceId]);

  // A test belongs to the device it was started on, and never outlives the page:
  // unmounting or hiding it (another settings page, a search) stops the test.
  useEffect(() => {
    if (!active) return;
    return stop;
  }, [stop, active, deviceId]);

  const running = state.phase === "running";
  const level = running ? state.sample.level : 0;
  const warn = running && (state.sample.silent || state.opened.substituted);

  return (
    <SettingsRow
      id="voice-mic-test"
      label="Test microphone"
      layout="stacked"
      description={<span role="status">{describe(state)}</span>}
      disabled={disabled}
      control={({ disabled: rowDisabled, descriptionId }) => (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            onClick={running ? stop : () => void start()}
            loading={state.phase === "starting"}
            // A running test can always be stopped, so the mic is never held
            // open by a row that became disabled mid-test.
            disabled={rowDisabled && !running}
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

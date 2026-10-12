import { spawn } from "child_process";

export interface SoundSettingsLauncher {
  command: string;
  args: string[];
}

const PAVUCONTROL: SoundSettingsLauncher = { command: "pavucontrol", args: [] };
const PAVUCONTROL_QT: SoundSettingsLauncher = { command: "pavucontrol-qt", args: [] };

// Keyed by the lowercased entries of XDG_CURRENT_DESKTOP ("ubuntu:GNOME", "KDE",
// "X-Cinnamon"…). XFCE has no audio panel of its own; Xubuntu's is pavucontrol.
const DESKTOP_LAUNCHERS: Record<string, SoundSettingsLauncher[]> = {
  gnome: [{ command: "gnome-control-center", args: ["sound"] }],
  unity: [{ command: "gnome-control-center", args: ["sound"] }],
  budgie: [{ command: "budgie-control-center", args: ["sound"] }],
  kde: [
    { command: "systemsettings", args: ["kcm_pulseaudio"] },
    { command: "systemsettings5", args: ["kcm_pulseaudio"] },
  ],
  "x-cinnamon": [{ command: "cinnamon-settings", args: ["sound"] }],
  mate: [{ command: "mate-volume-control", args: [] }],
  lxqt: [PAVUCONTROL_QT],
};

const STANDALONE_MIXERS: SoundSettingsLauncher[] = [
  PAVUCONTROL,
  { command: "pwvucontrol", args: [] },
  PAVUCONTROL_QT,
];

/** Sound settings apps to try, the session desktop's own first, then the standalone mixers. */
export function linuxSoundSettingsLaunchers(
  currentDesktop: string | undefined
): SoundSettingsLauncher[] {
  const desktops = (currentDesktop ?? "")
    .split(":")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const ordered = [...desktops.flatMap((d) => DESKTOP_LAUNCHERS[d] ?? []), ...STANDALONE_MIXERS];
  const seen = new Set<string>();
  return ordered.filter((launcher) => {
    const key = [launcher.command, ...launcher.args].join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * How long a launched settings app has to fail before it counts as open. Long
 * enough to catch gnome-control-center refusing to run outside GNOME (it exits
 * 1 at startup); a single-instance app handing off to its open window exits 0.
 */
export const SOUND_SETTINGS_START_GRACE_MS = 1000;

function launch(launcher: SoundSettingsLauncher, onFailure: (error: unknown) => void) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (opened: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!opened) onFailure(error);
      resolve(opened);
    };
    try {
      const child = spawn(launcher.command, launcher.args, { detached: true, stdio: "ignore" });
      // A missing binary arrives as an async "error" event, not a throw. The
      // listener stays for the child's life: unhandled, a late one becomes an
      // uncaughtException and takes the app into fatal recovery.
      child.on("error", (error) => settle(false, error));
      child.once("exit", (code, signal) =>
        settle(code === 0, new Error(`${launcher.command} exited (${signal ?? code})`))
      );
      child.unref();
      timer = setTimeout(() => settle(true), SOUND_SETTINGS_START_GRACE_MS);
    } catch (error) {
      settle(false, error);
    }
  });
}

/**
 * Open the desktop's sound settings, trying each candidate until one starts.
 * Resolves false when none did, so the caller can say so instead of the
 * button silently doing nothing.
 */
export async function openLinuxSoundSettings(
  currentDesktop: string | undefined,
  onFailure: (launcher: SoundSettingsLauncher, error: unknown) => void = () => {}
): Promise<boolean> {
  for (const launcher of linuxSoundSettingsLaunchers(currentDesktop)) {
    if (await launch(launcher, (error) => onFailure(launcher, error))) return true;
  }
  return false;
}

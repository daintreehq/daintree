/**
 * What Daintree's `systemd --user` units share: Host mode's start-at-login unit
 * and the timer that starts Daintree for scheduled runs. Kept out of Host
 * mode's modules so a build without the Host role bundles none of them.
 */

export const APPIMAGE_EXTRACT_AND_RUN_ENV = "APPIMAGE_EXTRACT_AND_RUN";

/**
 * Quote one ExecStart word. systemd expands `%` specifiers and `$` variables
 * inside quotes too, so both are doubled; backslashes and quotes are escaped.
 */
export function systemdQuote(arg: string): string {
  // A line break ends the directive and starts another; no quoting survives it.
  if (/[\r\n\0]/.test(arg)) {
    throw new Error("A start-at-login argument can't contain a line break or NUL");
  }
  const escaped = arg
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, "$$$$");
  return `"${escaped}"`;
}

/**
 * An AppImage run without FUSE stays systemd's main process, with Daintree as
 * its child, so a stop would signal the image's runtime and then kill
 * Daintree outright. This asks Daintree itself to quit first and waits for it
 * (within the stop timeout). Daintree is found as a child of this service's
 * main process, never from a pid recorded anywhere: the status file is written
 * only once Daintree listens, is left behind when it quits, and may name a
 * Daintree opened on the desktop or a pid since reused, and a stop during boot
 * or after a crash would then find nobody to ask. (Membership of the unit's
 * cgroup can't tell either: Chromium moves its main process into a scope of
 * its own as it starts.)
 */
export const APPIMAGE_STOP_SCRIPT = `[ -n "$MAINPID" ] || exit 0; p=; for s in /proc/[0-9]*/stat; do set -- $(cut -d')' -f2- "$s" 2>/dev/null); if [ "$2" = "$MAINPID" ]; then d=\${s%/stat}; p="$p \${d#/proc/}"; fi; done; [ -n "$p" ] || exit 0; kill -TERM $p 2>/dev/null; alive() { for q in $p; do kill -0 "$q" 2>/dev/null && return 0; done; return 1; }; i=0; while alive && [ "$i" -lt 100 ]; do sleep 0.25; i=$((i + 1)); done; exit 0`;

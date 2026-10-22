/**
 * An ssh destination as the host list accepts it: `user@host`, a host name or
 * IPv4 address, or an `~/.ssh/config` alias. No ports, URIs or options, and
 * never a leading `-` that ssh would read as a flag. A port, identity or
 * proxy comes from the user's own ssh config.
 */
export function isValidSshTarget(target: string): boolean {
  return /^[A-Za-z0-9_.@%+[\]-]{1,255}$/.test(target) && !target.startsWith("-");
}

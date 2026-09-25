import { setHostProjectsLoader } from "./hostProjects";

/**
 * Let the other-hosts listings read each host's projects through the Shell,
 * which reads this machine's store for "local" and asks a connected remote
 * host over its link. Returns the uninstall.
 */
export function installHostProjectsLoader(): () => void {
  const listHostProjects = window.electron?.remoteHosts?.listHostProjects;
  if (typeof listHostProjects !== "function") return () => {};
  setHostProjectsLoader((hostId) => listHostProjects({ hostId }));
  return () => setHostProjectsLoader(null);
}

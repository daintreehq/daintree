import { forgetHostProjects, setHostProjectsLoader } from "./hostProjects";

/**
 * Let the other-hosts listings read each host's projects through the Shell,
 * which reads this machine's store for "local" and asks a connected remote
 * host over its link, and drop a host's lists once it is removed or re-pointed
 * at another machine. Returns the uninstall.
 */
export function installHostProjectsLoader(): () => void {
  const api = window.electron?.remoteHosts;
  const listHostProjects = api?.listHostProjects;
  if (typeof listHostProjects !== "function") return () => {};
  setHostProjectsLoader((hostId) => listHostProjects({ hostId }));
  const stopForgetting =
    typeof api?.onEvent === "function"
      ? api.onEvent((event) => {
          if (event.type === "host-forgotten") forgetHostProjects(event.hostId);
        })
      : () => {};
  return () => {
    stopForgetting();
    setHostProjectsLoader(null);
  };
}

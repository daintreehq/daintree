import * as React from "react";

const DockPopoverChildContext = React.createContext<boolean>(false);

export function DockPopoverChildProvider({ children }: { children: React.ReactNode }) {
  return (
    <DockPopoverChildContext.Provider value={true}>{children}</DockPopoverChildContext.Provider>
  );
}

export function useIsDockPopoverChild(): boolean {
  return React.useContext(DockPopoverChildContext);
}

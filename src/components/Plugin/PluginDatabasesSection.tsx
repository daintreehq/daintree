import type { PluginDatabaseContribution } from "@shared/types/plugin";

/**
 * The SQLite files a plugin declares. Named in full because a project database
 * is a file in the user's repository that agents and git both see, and the
 * user should be able to find it without reading the manifest.
 */
export function PluginDatabasesSection({
  databases,
}: {
  databases: readonly PluginDatabaseContribution[];
}) {
  return (
    <div className="space-y-2">
      <h4 className="text-2xs font-medium uppercase tracking-wide text-text-secondary">
        Databases
      </h4>
      <ul className="space-y-2">
        {databases.map((database) => (
          <li key={database.id} className="text-xs">
            <div className="text-text-primary">{database.description ?? database.id}</div>
            <div className="text-2xs text-text-secondary mt-0.5 break-all">
              {database.location === "local" ? (
                "Stored on this machine, outside the project"
              ) : (
                <>
                  In the project at{" "}
                  <span className="font-mono select-text">
                    {database.path ?? `.daintree/data/…/${database.id}.db`}
                  </span>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

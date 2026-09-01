import Database from "better-sqlite3";

const INSTALL_MARK = Symbol.for("daintree.sqliteRunStatementCache.installed");
const MAX_CACHED_RUN_STATEMENTS = 128;

type AnyStatement = Database.Statement<unknown[]>;
type DatabasePrototype = Database.Database & { [INSTALL_MARK]?: true };

const statementCaches = new WeakMap<Database.Database, Map<string, AnyStatement>>();

function touchCachedStatement(
  db: Database.Database,
  source: string,
  statement: AnyStatement
): void {
  let cache = statementCaches.get(db);
  if (!cache) {
    cache = new Map();
    statementCaches.set(db, cache);
  }

  cache.delete(source);
  cache.set(source, statement);

  if (cache.size > MAX_CACHED_RUN_STATEMENTS) {
    const oldestSource = cache.keys().next().value;
    if (oldestSource !== undefined) cache.delete(oldestSource);
  }
}

/**
 * Reuse native prepared statements for the unconfigured `.run()` path.
 *
 * Drizzle creates a new query builder and calls `Database.prepare()` for every
 * synchronous insert/update/delete, even when the parameterised SQL is
 * identical. Compiling that SQL over and over is pure overhead. Read and
 * configured statements cannot be shared because methods such as `pluck()`,
 * `raw()`, `safeIntegers()` and `bind()` mutate the Statement instance, so the
 * proxy below isolates every path except a direct `.run()`.
 *
 * The cache is per connection, bounded, and weakly owned. A busy statement can
 * occur through a re-entrant SQLite callback; that call gets a fresh statement
 * rather than changing better-sqlite3's normal re-entrancy behaviour.
 */
export function installSqliteRunStatementCache(
  DatabaseConstructor: typeof Database = Database
): void {
  const prototype = DatabaseConstructor.prototype as DatabasePrototype;
  if (prototype[INSTALL_MARK]) return;

  const originalPrepare = prototype.prepare;

  prototype.prepare = function cachedPrepare<
    BindParameters extends unknown[] | Record<string, unknown> = unknown[],
    Result = unknown,
  >(this: Database.Database, source: string): Database.Statement<BindParameters, Result> {
    const cache = statementCaches.get(this);
    const cached = cache?.get(source);
    const runStatement = cached ?? (originalPrepare.call(this, source) as AnyStatement);
    const wasCached = cached !== undefined;

    let isolatedStatement: AnyStatement | undefined;
    let runClaimed = false;
    const isolate = (): AnyStatement => {
      if (isolatedStatement) return isolatedStatement;

      if (!wasCached && !runClaimed) {
        // A statement is not shared until its first direct `.run()`. A caller
        // that uses any other API first therefore owns the native statement.
        isolatedStatement = runStatement;
      } else {
        // Once `.run` has been claimed, this proxy may outlive other proxies
        // using the cached statement. Isolate late configuration too: bind(),
        // raw(), pluck() and safeIntegers() all mutate native Statement state.
        isolatedStatement = originalPrepare.call(this, source) as AnyStatement;
      }
      return isolatedStatement;
    };

    return new Proxy(runStatement, {
      get: (_target, property) => {
        if (property === "run" && !isolatedStatement) {
          runClaimed = true;
          return (...params: unknown[]) => {
            const statement = runStatement.busy
              ? (originalPrepare.call(this, source) as AnyStatement)
              : runStatement;
            const result = statement.run(...params);
            touchCachedStatement(this, source, runStatement);
            return result;
          };
        }

        const statement = isolate();
        const value = Reflect.get(statement, property, statement);
        return typeof value === "function" ? value.bind(statement) : value;
      },
    }) as Database.Statement<BindParameters, Result>;
  } as Database.Database["prepare"];

  Object.defineProperty(prototype, INSTALL_MARK, { value: true });
}

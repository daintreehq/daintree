// `npm run db:freeze`: record every migration in the journal as shipped. Run on
// the release branch, so the ledger holds exactly what the release ships.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  freezeMigrations,
  readMigrationLedger,
  readMigrationSource,
  serializeMigrationLedger,
} from "../electron/services/persistence/migrationLedger.js";

const persistenceDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
  "services",
  "persistence"
);
const ledgerPath = path.join(persistenceDir, "frozen-migrations.json");

try {
  const { ledger, added } = freezeMigrations(
    readMigrationLedger(ledgerPath),
    readMigrationSource(path.join(persistenceDir, "migrations"))
  );
  if (added.length === 0) {
    console.log("No new migrations to freeze.");
  } else {
    fs.writeFileSync(ledgerPath, serializeMigrationLedger(ledger));
    console.log(
      `Froze ${added.map((m) => m.tag).join(", ")} in ${path.relative(process.cwd(), ledgerPath)}.`
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

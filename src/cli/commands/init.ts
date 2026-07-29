import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { resolveDataDir } from "../../core/context.js";
import { openDb } from "../../db/client.js";
import { CONFIG_FILE_NAME, renderDefaultConfigYaml } from "../../config/config.js";
import { handleError } from "../context.js";

export function registerInitCommand(program: Command): void {
  const cmd = program
    .command("init")
    .description("Initialize .kahanyaku/ (SQLite database, config) and data/notes/")
    .option("--data-dir <dir>", "data directory (default: ./.kahanyaku or $KAHANYAKU_HOME)")
    .action(async (opts: { dataDir?: string }) => {
      try {
        const dataDir = resolveDataDir(opts.dataDir);
        const dbPath = path.join(dataDir, "kahanyaku.sqlite");
        const configPath = path.join(dataDir, CONFIG_FILE_NAME);
        const notesDir = path.resolve("data/notes");

        const dbAlreadyExisted = fs.existsSync(dbPath);
        const configAlreadyExisted = fs.existsSync(configPath);

        // openDb() is safe to call repeatedly: it creates the dir/file and runs
        // migrations idempotently (already-applied migrations are skipped).
        const db = openDb(dataDir);
        db.close();

        if (!configAlreadyExisted) {
          fs.writeFileSync(configPath, renderDefaultConfigYaml(), "utf-8");
        }
        fs.mkdirSync(notesDir, { recursive: true });

        if (dbAlreadyExisted && configAlreadyExisted) {
          console.log(pc.yellow(`Already initialized at ${dataDir} (nothing changed).`));
        } else {
          console.log(pc.green(`Initialized 加判役（Kahanyaku）at ${dataDir}`));
        }
        console.log(`  database: ${dbPath}`);
        console.log(`  config:   ${configPath}${configAlreadyExisted ? " (already existed, left untouched)" : ""}`);
        console.log(`  notes:    ${notesDir}`);
      } catch (err) {
        handleError(cmd, err);
      }
    });
}

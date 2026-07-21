import { createReadStream, createWriteStream } from "node:fs";
import { access, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { decryptJsonLine, encryptJsonLine, parseCollectorDataKey } from "./collector-server.mjs";

const LEGACY_NAME = /^(captures|alarms|alarm-events|decisions|action-attempts|audit|ledger)-\d{4}-\d{2}-\d{2}\.jsonl$/;

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeLine(output, line) {
  if (!output.write(`${line}\n`, "utf8")) await once(output, "drain");
}

export async function migrateCollectorFile(filePath, dataKey) {
  const source = path.resolve(filePath);
  if (!LEGACY_NAME.test(path.basename(source))) throw new Error(`Unsupported legacy collector file: ${source}`);
  const target = source.replace(/\.jsonl$/, ".encjsonl");
  const temporary = `${target}.tmp`;
  const backup = `${source}.plaintext-pending-delete`;
  if (await exists(target) || await exists(temporary) || await exists(backup)) {
    throw new Error(`Migration target already exists for ${source}`);
  }

  const input = createReadStream(source, { encoding: "utf8" });
  const output = createWriteStream(temporary, { encoding: "utf8", flags: "wx" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let recordCount = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      const encrypted = encryptJsonLine(value, dataKey);
      const verified = decryptJsonLine(encrypted, dataKey);
      if (JSON.stringify(verified) !== JSON.stringify(value)) throw new Error(`Encryption verification failed at record ${recordCount + 1}`);
      await writeLine(output, encrypted);
      recordCount += 1;
    }
    output.end();
    await once(output, "close");
    await rename(source, backup);
    await rename(temporary, target);
    await rm(backup, { force: true });
    return { source, target, recordCount };
  } catch (error) {
    output.destroy();
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function migrateCollectorDirectory(dataDir, dataKey) {
  const directory = path.resolve(dataDir);
  const names = (await readdir(directory)).filter((name) => LEGACY_NAME.test(name)).sort();
  const results = [];
  for (const name of names) results.push(await migrateCollectorFile(path.join(directory, name), dataKey));
  return results;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const dataDir = path.resolve(process.env.DATA_DIR || "collector-data");
  const dataKey = parseCollectorDataKey(process.env.COLLECTOR_DATA_KEY);
  if (!dataKey) throw new Error("COLLECTOR_DATA_KEY is required");
  const results = await migrateCollectorDirectory(dataDir, dataKey);
  console.log(JSON.stringify({ ok: true, files: results.length, records: results.reduce((sum, item) => sum + item.recordCount, 0) }));
}

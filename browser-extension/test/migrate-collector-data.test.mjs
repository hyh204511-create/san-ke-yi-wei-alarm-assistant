import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decryptJsonLine } from "../collector-server.mjs";
import { migrateCollectorDirectory } from "../migrate-collector-data.mjs";

test("legacy plaintext collector files migrate to verified encrypted lines", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hn-collector-migrate-"));
  const source = path.join(dataDir, "captures-2026-07-19.jsonl");
  const values = [{ captureId: "one", vehicleNo: "TEST-01" }, { captureId: "two", location: "sensitive" }];
  await writeFile(source, `${values.map(JSON.stringify).join("\n")}\n`, "utf8");
  const key = Buffer.alloc(32, 9);
  const results = await migrateCollectorDirectory(dataDir, key);
  assert.equal(results[0].recordCount, 2);
  const names = await readdir(dataDir);
  assert.deepEqual(names, ["captures-2026-07-19.encjsonl"]);
  const encryptedLines = (await readFile(path.join(dataDir, names[0]), "utf8")).trim().split("\n");
  assert.doesNotMatch(encryptedLines.join(""), /TEST-01|sensitive/);
  assert.deepEqual(encryptedLines.map((line) => decryptJsonLine(line, key)), values);
});

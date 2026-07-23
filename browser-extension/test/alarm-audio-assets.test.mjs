import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const manifestUrl = new URL("../assets/alarm-audio/speeding.manifest.json", import.meta.url);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseWav(buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12;
  let format = null;
  let dataBytes = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      };
    }
    if (id === "data") dataBytes = size;
    offset = start + size + (size % 2);
  }
  return { ...format, dataBytes };
}

test("超速报警话术与音频资产保持一致且只允许已发布真实规则引用", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const expectedText = "驾驶员，平台已报警，车辆超速驾驶，请降速安全行驶。";
  assert.equal(manifest.ruleCode, "SPEEDING");
  assert.equal(manifest.text, expectedText);
  assert.equal(manifest.review.status, "APPROVED");
  assert.equal(manifest.review.integrationAllowed, true);
  assert.match(manifest.review.notes, /已发布的超速驾驶真实自动规则/);

  for (const file of Object.values(manifest.files)) {
    const fileUrl = new URL(file.path, manifestUrl);
    const content = await readFile(fileUrl);
    assert.equal(sha256(content), file.sha256);
  }

  const text = await readFile(new URL(manifest.files.text.path, manifestUrl), "utf8");
  assert.equal(text.trim(), expectedText);
});

test("平台PCM为8kHz 16bit单声道小端格式且与母版时长一致", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const wav = await readFile(new URL(manifest.files.master.path, manifestUrl));
  const pcm = await readFile(new URL(manifest.files.platformPcm.path, manifestUrl));
  const wavInfo = parseWav(wav);

  assert.deepEqual(wavInfo, {
    audioFormat: 1,
    channels: 1,
    sampleRate: 32000,
    bitsPerSample: 16,
    dataBytes: 554386
  });
  assert.equal(manifest.files.platformPcm.format, "PCM_S16LE");
  assert.equal(manifest.files.platformPcm.sampleRate, 8000);
  assert.equal(manifest.files.platformPcm.sampleWidthBits, 16);
  assert.equal(manifest.files.platformPcm.channels, 1);
  assert.equal(manifest.files.platformPcm.endianness, "little");
  assert.equal(pcm.length, manifest.files.platformPcm.byteLength);
  assert.equal(pcm.length % 2, 0);
  const pcmDuration = pcm.length / (8000 * 2);
  assert.ok(Math.abs(pcmDuration - manifest.durationSeconds) < 0.001);
  assert.equal(manifest.qualityChecks.clippedSamples, 0);
  assert.equal(manifest.qualityChecks.leading200msSilent, true);
  assert.equal(manifest.qualityChecks.trailing200msSilent, true);
});

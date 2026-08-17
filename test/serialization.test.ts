import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractText, readJson, stableJson, writeJson } from "../src/lib.ts";

test("stable JSON recursively sorts object keys", () => {
  assert.equal(
    stableJson({ z: 1, nested: { b: 2, a: 1 }, array: [{ d: 4, c: 3 }] }, 0),
    '{"array":[{"c":3,"d":4}],"nested":{"a":1,"b":2},"z":1}',
  );
});

test("JSON files round-trip through atomic writes", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-archive-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "nested", "value.json");

  await writeJson(destination, { z: 1, a: 2 });

  assert.deepEqual(await readJson(destination), { a: 2, z: 1 });
  assert.equal(await readFile(destination, "utf8"), '{\n  "a": 2,\n  "z": 1\n}\n');
  assert.equal(await readJson(path.join(directory, "missing.json"), "fallback"), "fallback");
});

test("plain-text extraction normalizes whitespace and records the output", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-extract-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.txt");
  const destination = path.join(directory, "text", "source.txt");
  await writeFile(source, "first  \r\n\r\n\r\n\r\nsecond\n");

  const result = await extractText(source, destination);

  assert.equal(result.status, "extracted");
  assert.equal(result.bytes, Buffer.byteLength("first\n\n\nsecond"));
  assert.equal(await readFile(destination, "utf8"), "first\n\n\nsecond\n");
});

test("unsupported extraction does not create a sidecar", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-extract-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.bin");
  await writeFile(source, "binary-ish");

  assert.deepEqual(await extractText(source, path.join(directory, "source.txt")), { status: "unsupported", bytes: 0 });
});

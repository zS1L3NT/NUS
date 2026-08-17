import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { canvasError } from "../src/canvas-client.ts";
import { resolvePath } from "../src/config.ts";
import {
  assignmentDates,
  changeSummary,
  embeddedFileIds,
  incompleteDocumentKinds,
  parseOptions,
  sanitizeCanvasSecrets,
} from "../src/sync.ts";

test("Canvas secrets are redacted recursively without changing other values", () => {
  const input = {
    url: "https://canvas.example/file?verifier=secret&download=1",
    nested: ["https://canvas.example?access_token=token", "https://canvas.example?verifier=secret\\tail", 42],
  };
  assert.deepEqual(sanitizeCanvasSecrets(input), {
    url: "https://canvas.example/file?verifier=<redacted>&download=1",
    nested: ["https://canvas.example?access_token=<redacted>", "https://canvas.example?verifier=<redacted>", 42],
  });
});

test("structured Canvas errors are recovered from mixed stderr output", () => {
  const error = { stderr: 'diagnostic\n{"command":"files.download","error":"not available"}\n' };
  assert.deepEqual(canvasError(error), {
    raw: 'diagnostic\n{"command":"files.download","error":"not available"}',
    structured: { command: "files.download", error: "not available" },
  });
});

test("project paths resolve consistently", () => {
  assert.equal(resolvePath("./raw", "/project"), path.normalize("/project/raw"));
  assert.equal(resolvePath("/archive/raw", "/project"), path.normalize("/archive/raw"));
});

test("embedded file IDs are discovered and deduplicated", () => {
  assert.deepEqual([...embeddedFileIds({ body: "/files/42", nested: ["/files/7", "/files/42"] })], [42, 7]);
});

test("assignment dates retain course and override audiences", () => {
  assert.deepEqual(
    assignmentDates({ due_at: "2026-08-20", unlock_at: null, lock_at: null }, [
      {
        id: 9,
        title: "Tutorial group",
        due_at: "2026-08-21",
        student_ids: [1, 2],
      },
    ]),
    [
      {
        audience: "Course",
        due_at: "2026-08-20",
        unlock_at: null,
        lock_at: null,
      },
      {
        audience: "Tutorial group",
        due_at: "2026-08-21",
        unlock_at: undefined,
        lock_at: undefined,
        override_id: 9,
        course_section_id: null,
        group_id: null,
        student_ids: [1, 2],
      },
    ],
  );
});

test("collection warnings map to the affected document kinds", () => {
  assert.deepEqual(
    incompleteDocumentKinds([
      { kind: "page-list" },
      { kind: "assignment-list" },
      { kind: "file" },
      { kind: "file-list" },
    ]),
    ["page", "assignment", "file"],
  );
});

test("sync options select a course and honor metadata-only mode", () => {
  const config = {
    courses: [{ code: "CS1" }, { code: "CS2" }],
    downloadFiles: true,
    extractText: true,
  };
  assert.deepEqual(parseOptions(config, ["--course", "cs2", "--metadata-only"]), {
    courses: [{ code: "CS2" }],
    downloadFiles: false,
    extractText: false,
  });
  assert.throws(() => parseOptions(config, ["--course", "missing"]), /Unknown course: MISSING/);
});

test("change summaries count each action", () => {
  assert.deepEqual(
    changeSummary([{ action: "added" }, { action: "added" }, { action: "modified" }, { action: "removed" }]),
    { added: 2, modified: 1, removed: 1 },
  );
});

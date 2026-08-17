import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFilenameSuffix,
  canvasAssignmentOrder,
  canvasModuleOrder,
  collisionSafeNames,
  compareStates,
  documentRecord,
  htmlToMarkdown,
  orderPrefix,
  preserveIncompleteState,
  safeName,
  stateFromDocuments,
} from "../src/lib.ts";

test("HTML normalization preserves useful text and links", () => {
  assert.equal(
    htmlToMarkdown('<h2>Hello</h2><p>See <a href="https://example.com">resource</a>.</p>'),
    "## Hello\n\nSee [resource](https://example.com).\n",
  );
});

test("safe file names remove path separators", () => {
  assert.equal(safeName("../Week 1: Intro.pdf"), "-Week 1- Intro.pdf");
});

test("Finder-friendly names use padded order", () => {
  assert.equal(orderPrefix(7), "(007) ");
  assert.equal(appendFilenameSuffix("Lecture 1.pdf", "[Canvas 42]"), "Lecture 1 [Canvas 42].pdf");
});

test("Canvas IDs are only added to colliding display names", () => {
  const first = { id: 1, name: "Notes.pdf" };
  const second = { id: 2, name: "notes.pdf" };
  const third = { id: 3, name: "Slides.pdf" };
  const items = [first, second, third];
  const names = collisionSafeNames(
    items,
    (item) => item.name,
    (item) => item.id,
  );
  assert.equal(names.get(first), "Notes [Canvas 1].pdf");
  assert.equal(names.get(second), "notes [Canvas 2].pdf");
  assert.equal(names.get(third), "Slides.pdf");
});

test("module and assignment ordering follows Canvas position fields", () => {
  const moduleOrder = canvasModuleOrder([
    { id: 20, position: 2, items: [{ type: "Page", page_url: "second", position: 1 }] },
    {
      id: 10,
      position: 1,
      items: [
        { type: "File", content_id: 8, position: 2 },
        { type: "Page", page_url: "first", position: 1 },
      ],
    },
  ]);
  assert.equal(moduleOrder.moduleRanks.get(10), 1);
  assert.equal(moduleOrder.pageRanks.get("first"), 1);
  assert.equal(moduleOrder.fileRanks.get(8), 2);
  assert.equal(moduleOrder.pageRanks.get("second"), 3);

  const assignmentOrder = canvasAssignmentOrder(
    [
      { id: 2, assignment_group_id: 20, position: 1 },
      { id: 1, assignment_group_id: 10, position: 2 },
      { id: 3, assignment_group_id: 10, position: 1 },
    ],
    [
      { id: 20, position: 2 },
      { id: 10, position: 1 },
    ],
  );
  assert.deepEqual([...assignmentOrder.keys()], [3, 1, 2]);
});

test("state comparison reports stable content changes", () => {
  const before = stateFromDocuments([
    documentRecord({ id: 1, kind: "page", course: "CS1", title: "A", content: "old" }),
  ]);
  const after = stateFromDocuments([
    documentRecord({ id: 1, kind: "page", course: "CS1", title: "A", content: "new" }),
  ]);
  const changes = compareStates(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.action, "modified");
  assert.deepEqual(
    changes[0]?.fields.map((field) => field.field),
    ["content_sha256"],
  );
});

test("incomplete resource collections do not report removals", () => {
  const before = stateFromDocuments([
    documentRecord({ id: 1, kind: "page", course: "CS1", title: "A", content: "old" }),
  ]);
  const preserved = preserveIncompleteState(before, {}, ["page"]);
  assert.deepEqual(preserved, before);
  assert.deepEqual(compareStates(before, preserved, ["page"]), []);
});

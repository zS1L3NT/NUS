import test from 'node:test';
import assert from 'node:assert/strict';
import { compareStates, documentRecord, htmlToMarkdown, safeName, stateFromDocuments } from '../src/lib.mjs';

test('HTML normalization preserves useful text and links', () => {
  assert.equal(htmlToMarkdown('<h2>Hello</h2><p>See <a href="https://example.com">resource</a>.</p>'), '## Hello\n\nSee [resource](https://example.com).\n');
});

test('safe file names remove path separators', () => {
  assert.equal(safeName('../Week 1: Intro.pdf'), '-Week 1- Intro.pdf');
});

test('state comparison reports stable content changes', () => {
  const before = stateFromDocuments([documentRecord({ id: 1, kind: 'page', course: 'CS1', title: 'A', content: 'old' })]);
  const after = stateFromDocuments([documentRecord({ id: 1, kind: 'page', course: 'CS1', title: 'A', content: 'new' })]);
  const changes = compareStates(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].action, 'modified');
  assert.deepEqual(changes[0].fields.map((field) => field.field), ['content_sha256']);
});

test('incomplete resource collections do not report removals', () => {
  const before = stateFromDocuments([documentRecord({ id: 1, kind: 'page', course: 'CS1', title: 'A', content: 'old' })]);
  assert.deepEqual(compareStates(before, {}, ['page']), []);
});

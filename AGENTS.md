# Agent instructions

This repository has two distinct operating modes. Determine which mode the task belongs to before acting, and do not combine the modes unless the user explicitly asks for both.

## Rules for every agent

- Never stage, unstage, commit, amend, reset, or otherwise manage Git state. Git staging and commits belong to the user.
- Never expose, copy, log, or persist Canvas credentials. Authentication is held outside this repository in the macOS Keychain.
- Never create, update, submit, grade, publish, or delete anything in Canvas. This project is read-only with respect to Canvas.
- Treat `raw/` as generated machine course data, the configured `viewDirectory` as the user-facing copied view, and `src/`, `test/`, `config.json`, and `known-content.json` as the archiver implementation.
- Preserve stable identifiers, source URLs, timestamps, hashes, and warning details. They are required for reliable diffs and indexing.
- Preserve and display external links found in Canvas content. If externally hosted content cannot be downloaded, the visible link is still part of the archive and indexing result.
- Read warning messages themselves; do not reduce them to warning counts.
- Interpret warnings in context. A warning is a coverage note, not automatically an archiver error or proof that content is missing.
- Do not restore or depend on the retired browser/AppleScript scraper or legacy verification artifacts.

## Mode A: repository maintainers

Use this mode when changing the archiver, configuration, tests, documentation, extraction, normalization, diffing, or archive layout.

### Source of truth

- `src/sync.mjs`: Canvas collection and archive generation.
- `src/lib.mjs`: normalization, hashing, text extraction, and comparison helpers.
- `config.json`: course scope and archive settings.
- `known-content.json`: direct Canvas identifiers used when list endpoints are unavailable.
- `test/`: regression tests.
- `README.md`: user-facing operation notes.

### Maintenance requirements

- Keep all Canvas operations read-only and use the pinned binary at `tools/canvas-cli/current/canvas`.
- Prefer structured JSON from Canvas and deterministic, atomic outputs.
- Optimize generated content for semantic diffing and AI indexing: stable ordering, stable IDs, normalized text, explicit metadata, and content hashes.
- Do not hand-edit generated files under `raw/` or the configured view directory. Change the generator and run a sync instead.
- Do not report removals for resource kinds whose collection was incomplete or warned.
- Keep full warning messages in human-readable reports, including the affected file ID and filename where available.
- Preserve valid existing downloads when Canvas temporarily stops providing a download URL. Never substitute an HTML error response for a PDF, Office document, or other attachment.
- A missing pages, quizzes, or similar collection may be normal for a course that does not use that Canvas feature. Preserve the warning, but do not describe it as missing course content without corroborating evidence from modules or known identifiers.
- A file record with no download URL is commonly gated or unreleased by teaching staff. Preserve its metadata, warn that its content is not currently downloadable, and retry it on later syncs.
- Avoid deleting raw content unless the user explicitly authorizes it and the exact targets have been verified.
- Do not add grades, submissions, quiz attempts, rosters, conversations, or other sensitive student data without explicit user direction.

### Verification

After implementation changes, run checks proportionate to the change:

```sh
npm test
npm run doctor
```

Run `npm run sync` only when a live, read-only refresh is needed. A successful sync should produce:

- `raw/INDEX.md`
- one `raw/<COURSE>/INDEX.md` per collected course
- normalized `documents.jsonl` records
- file manifests and extracted-text sidecars
- `raw/logs/latest.md` and `raw/logs/latest.json`

Review the actual warnings and the added/modified/removed diff before declaring success.

## Mode B: Canvas to Notion task tracker and NUS Exams calendar

Use this mode whenever the user asks for a Canvas to Notion update. Its purpose is to verify that Canvas task information is represented accurately and completely in **NUS Journey > Task Tracker** in Notion, enrich existing task pages with useful source information, and verify important one-time examinations in the **NUS Exams** Google Calendar.

### Operating boundary

- Treat Canvas and this repository as read-only sources.
- Treat Notion as read-mostly. The standing write permission is limited to adding important Canvas information inside the body of an existing task page.
- Do not change a Notion task date or other database property unless the user explicitly authorizes that property write for the current update. When authorized, write only dates confirmed by reliable Canvas course material and report every property changed.
- Do not create a missing task or alter database properties unless the user gives explicit permission for that specific action.
- Avoid changing existing page blocks. Change a block only to correct information that is demonstrably wrong, and report exactly what was corrected.
- Never delete a Notion page, block, property, or other content without the user's explicit approval. Absence from Canvas, a partial run, or a warning is never deletion approval.
- Never write back to Canvas.
- Google Calendar access is limited to the calendar named **NUS Exams** and to important, one-time, high-weight examinations. Inspect it on every full update when calendar access is available.
- Create or update an **NUS Exams** event only when the user has authorized calendar writes and the date and time are confirmed by reliable course material. Never create an event from a TBA, ambiguous, internally inconsistent, or stale source.
- Do not use Google Calendar for assignments, quizzes, tutorials, diagnostics, study windows, or tasks that run over a period of time. Those belong in Notion.
- Never delete or cancel a calendar event without the user's explicit approval.
- Do not alter `raw/`, the configured view directory, implementation files, configuration, or logs, and do not run a live Canvas sync unless the user specifically asks for one.

### Sources and verification order

1. Inspect **NUS Journey > Task Tracker** in Notion, including every current task's subject, title, date, and page body.
2. Inspect the **NUS Exams** Google Calendar for existing one-time examination events when calendar access is available.
3. Read `raw/logs/latest.json` for the Canvas run timestamp, course scope, collection completeness, and full warnings.
4. Read `raw/INDEX.md` for the corpus overview and assignment dates.
5. Read each in-scope `raw/<COURSE>/documents.jsonl` as the canonical normalized Canvas record stream.
6. Use `raw/<COURSE>/content/`, `raw/<COURSE>/content/text/files/`, and `file-manifest.json` when task instructions or attachment text are needed.
7. Use raw records only to resolve an ambiguity; do not use `raw/` as the default source.

If the user explicitly requests a fresh Canvas update, perform the authorized read-only refresh first, review its warnings, and then use the completed archive as the comparison source.

### Required audit on every update

Perform all of the following checks every time, even when the user asks generally for an "update":

1. **Date accuracy:** compare every current Notion task date with the applicable Canvas availability and due dates, including relevant student-specific overrides. Unless the user has authorized date writes for the current update, list every discrepancy without editing it. When date writes are authorized, update only confirmed dates and report what remains uncertain.
2. **Task completeness:** for each subject in scope, compare Canvas tasks against Task Tracker and identify every missing Notion task. Also flag uncertain matches, duplicates, or apparent extras separately; do not resolve them by writing or deleting.
3. **Page information:** inspect each matched task page and add important missing information from Canvas to the page body. Useful information includes submission requirements, instructions, grading or rubric details, availability restrictions, required links, attachment summaries, and material changes that affect completing the task.
4. **Exam completeness:** compare important one-time, high-weight examinations against **NUS Exams**. Keep confirmed exams in Google Calendar rather than creating duplicate Notion tasks. Report missing, conflicting, or unconfirmed exam events.

Match records using stable Canvas identifiers or source URLs when available. Use title, subject, and date only as supporting evidence; never assume a title-only match is reliable.

### Writing task-page information

- Add concise, task-relevant information inside the existing task page body only.
- Preserve the Canvas source URL and important external links as clickable links with meaningful labels.
- Store availability windows and due dates in the `Due date` property when the user has authorized the property write. Do not duplicate those dates in the page body merely for indexing; keep body dates only when they are necessary to explain a policy, conflict, or sequence of requirements.
- Prefer an additive section or clearly separated update over rewriting existing user-authored notes.
- Do not duplicate information already present on the page.
- Do not replace an entire page body when a small addition or correction is sufficient.
- Do not upload original course attachments unless the user explicitly authorizes the upload.
- If attachment text is unavailable, retain and add the available metadata or source link and state that the content could not be read.
- Use Canvas as the factual authority for Canvas task details, but preserve the user's personal notes and planning content.
- If Canvas and Notion conflict outside the date field, correct only clearly wrong task-page body content. Leave ambiguous conflicts unchanged and report them.

### Partial coverage and warnings

- Limit completeness claims to courses covered by the latest completed Canvas run. An omitted course may be outside a partial run and must not be treated as empty or removed.
- Read warning messages themselves rather than relying on warning counts.
- A warning may represent an unused feature, access control, or unreleased content. Do not infer that a task is absent or deleted when relevant Canvas coverage is incomplete.
- Report uncertainty whenever warnings, gated content, missing download URLs, or ambiguous Notion matches prevent a reliable conclusion.

### Completion report

After every Canvas to Notion update, tell the user:

- the Canvas run timestamp and subjects checked;
- every Notion date property changed, plus every unresolved date the user still needs to review; if date writes were not authorized, explicitly confirm that no dates were modified;
- every missing, uncertain, duplicate, or extra task found by subject;
- roughly what information was added to existing task pages;
- each existing block that was corrected, identifying the task and what changed;
- anything created or otherwise updated in Notion outside additive page-body content, which should normally be nothing unless separately authorized;
- every **NUS Exams** event created, updated, already correct, missing, or left unchanged because its source was uncertain;
- the full relevant Canvas warnings and any items that could not be verified;
- confirmation that nothing was deleted, including from Notion or Google Calendar.

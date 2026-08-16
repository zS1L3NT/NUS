# NUS Canvas corpus via canvas-cli

This is the active, deterministic Canvas archiver. It uses the pinned `canvas-cli` binary in `tools/canvas-cli/` for authentication, pagination, rate limiting, API reads, and file downloads.

## Output design

Raw machine data stays in the repository under `./raw`; the Finder-facing view is written outside the repository under `~/NUS` by default. Change `rawDirectory` and `viewDirectory` in `config.json` to customize them:

- `~/NUS/<COURSE>/` is the Finder-facing Canvas-shaped view, with symlinked Modules, Quizzes, Assignments, Announcements, Files, and unlinked pages at its root;
- `raw/<COURSE>/` is machine-only: lossless Canvas responses, normalized records, manifests, state, and downloaded content;
- `raw/<COURSE>/content/text/` contains deterministic text sidecars for supported text, HTML, PDF, Word, PowerPoint, Excel, ZIP, and OCR-readable image files;
- `raw/<COURSE>/documents.jsonl` contains stable, normalized records for AI indexing;
- `raw/<COURSE>/file-manifest.json` records original attachment metadata, hashes, and extraction status;
- `raw/logs/latest.md` and `raw/logs/latest.json` report additions, modifications, and removals; timestamped older reports are kept under `raw/logs/older/`.
- `~/NUS/logs/latest.md` is the Finder-facing change report; dated Markdown reports under `~/NUS/logs/older/` contain the readable history.

## Finder-friendly names and ordering

- The configured view tree uses Canvas module order and indentation, so it is the browsing side of the corpus.
- Every Canvas folder and item view is numbered from `(001)` at its own level; child folders restart numbering at `(001)`.
- The `raw/<COURSE>/content/` tree uses stable Canvas IDs and machine-oriented names; it is the backing side and is not intended for normal reading.
- Pages, assignments, and files in the view tree point back to `raw/<COURSE>/content/` with relative symlinks, so each item has one source copy.
- Online-only module items are represented by small Markdown link stubs.
- After a complete Canvas listing, files and generated documents that Canvas has removed are deleted locally. Cleanup is skipped for a resource type whenever its Canvas listing is incomplete or fails.

Credentials are not stored here. `canvas-cli` reads the API token from the macOS Keychain.

## Commands

```sh
npm run doctor
npm run sync
npm run sync -- --course CS2030S
npm run sync -- --metadata-only
npm run rebuild-views
npm test
```

`npm run sync` is the full rebuild path: it reads Canvas, downloads missing raw attachments, writes normalized content, and regenerates every symlinked view. If a course’s `raw/<COURSE>/` directory is removed first, the next successful sync recreates it from scratch. `npm run rebuild-views` only regenerates views from the existing local raw corpus and does not contact Canvas.

All Canvas operations in the implementation are reads. It intentionally excludes grades, submissions, quiz attempts, rosters, conversations, and every Canvas create/update/delete operation.

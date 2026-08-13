# NUS Canvas corpus via canvas-cli

This is the active, deterministic Canvas archiver. It uses the pinned `canvas-cli` binary in `tools/canvas-cli/` for authentication, pagination, rate limiting, API reads, and file downloads.

## Output design

The corpus is written to `archive/`:

- `raw/` preserves lossless structured Canvas responses;
- `documents.jsonl` contains stable, normalized records for AI indexing;
- `documents/` contains readable Markdown for pages, assignments, and announcements;
- `files/` contains original Canvas attachments;
- `text/files/` contains deterministic text sidecars for supported text, HTML, PDF, Word, PowerPoint, Excel, ZIP, and OCR-readable image files;
- `state.json` records stable hashes and metadata for comparisons;
- `logs/latest.md` and `logs/latest.json` report additions, modifications, and removals.

Credentials are not stored here. `canvas-cli` reads the API token from the macOS Keychain.

## Commands

```sh
npm run doctor
npm run sync
npm run sync -- --course CS2030S
npm run sync -- --metadata-only
npm test
```

All Canvas operations in the implementation are reads. It intentionally excludes grades, submissions, quiz attempts, rosters, conversations, and every Canvas create/update/delete operation.

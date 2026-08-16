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
- `logs/latest.md` and `logs/latest.json` report additions, modifications, and removals; timestamped older reports are kept under `logs/older/`.

## Finder-friendly names and ordering

- Canvas IDs are not placed at the front of filenames. An ID is appended only when two items in the same folder would otherwise have the same name.
- Modules use their Canvas `position`. Pages and files referenced by modules use the order of their module items.
- Assignments use assignment-group order followed by their position inside the group.
- Announcements are numbered oldest first, so each later post gets a larger stable number without renaming earlier files.
- Items without a lecturer-defined Canvas position are left unnumbered rather than implying an order Canvas did not provide.
- After a complete Canvas listing, files and generated documents that Canvas has removed are deleted locally. Cleanup is skipped for a resource type whenever its Canvas listing is incomplete or fails.

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

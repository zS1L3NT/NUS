# canvas-cli runtime

This directory contains the pinned `canvas-cli` binary used by the NUS Canvas archive migration.

- Version: `v1.13.0`
- Platform: macOS Apple Silicon (`darwin_arm64`)
- Upstream: <https://github.com/jjuanrivvera/canvas-cli>
- Archive SHA-256: `6266bec05d4f30548ecd42d626a1da214b7821323fcb2a709afac421973ef378`

Run it as `./tools/canvas-cli/current/canvas` from `~/NUS Canvas`.

Credentials are deliberately not stored in this project. The CLI should use the macOS Keychain.

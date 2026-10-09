# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-09

### Added

- `ConsoleFixSandboxProvider`, a `@deepseek-ai/dsh-sandbox-local` subclass that inserts
  `--import <console-shim.mjs>` in front of the Windows ACL sandbox runner entry, so the runner
  process allocates a console that the confined child inherits.
- `console-shim.mjs`: best-effort `AllocConsole()` via koffi, with a fallback to the koffi copy
  bundled inside the running Harness.
- `cordis.patch.yml`: disables the shipped `sandbox` row and mounts this provider in its place.
  Both rows are platform-guarded with the Loader's `!!js` dialect (`process.platform`), the idiom the
  shipped `dsh-base` patch uses for its own `bash-sandbox` row, so the bundle is inert off Windows.
- Verification record and reproduction scripts.

### Changed

- **Dependency-free.** `index.js` loads `LocalSandboxProvider` from the running Harness bundle
  (falling back to a local install), and `console-shim.mjs` resolves `koffi` there too. Installing the
  bundle therefore needs no `pnpm install`, no build-script approval and no peer closure — verified by
  loading the plugin under the Harness Electron binary.

### Verified

- Failure needs the Electron host **and** `workspace-write`: that combination exits `3221225794`
  (`0xC0000142`), while `read-only` and a `node.exe` host both exit `7`.
- With the shim, the same runner exits `0`/`7` in **both** modes, directly and through the full
  subprocess-runner chain.
- Confinement unchanged: writes to four out-of-workspace targets denied and absent on disk; an
  in-workspace write succeeds.

[Unreleased]: https://github.com/TJZF-4j97/dsh-sandbox-console-fix/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/TJZF-4j97/dsh-sandbox-console-fix/releases/tag/v0.1.0




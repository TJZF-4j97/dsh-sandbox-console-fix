# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-10

### Fixed

- `console-shim.mjs` now saves and restores the runner's three standard handles around
  `AllocConsole()`, so the runner's own stdout/stderr keep pointing at the Harness. Measured in the
  Harness Electron environment: `1816/1624/1700` -> `712/716/720` without the restore, unchanged with it.
- `console-shim.mjs` now hides the console window it allocates. A console allocated in a host that was
  not spawned with `SW_HIDE` is otherwise visible (`IsWindowVisible(GetConsoleWindow())` true, window
  titled after the host image); an already-existing console is left untouched for developers running
  from a terminal.

### Changed

- Documentation: the failure shape is recorded as the `native-init` family named by
  `@argszero/cordis-plugin-sandbox-grant-advisor`, together with the measured remedies from discussions
  #8193/#8208 and the longer write-up in #9238; and the ruling that makes the failure opaque
  (`RUNNER_FAILURE_RULES['windows-acl']` is exit-127-gated by design) is now documented with its source
  anchor.
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

[Unreleased]: https://github.com/TJZF-4j97/dsh-sandbox-console-fix/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/TJZF-4j97/dsh-sandbox-console-fix/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/TJZF-4j97/dsh-sandbox-console-fix/releases/tag/v0.1.0


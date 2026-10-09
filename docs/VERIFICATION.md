# Verification record

Everything below was produced **locally on Windows 11 22H2 (build 22621, x64)** with DeepSeek Harness
`0.2.0-rc.2`, by driving the Harness's *own* sandbox code (an extracted copy of
`dsh-sandbox-windows-acl` / `dsh-win32-process` / `dsh-subprocess-local`) and the real Electron host
binary. No system security setting, ACL, policy or Harness configuration was modified.

**This entire record is AI-generated and NOT REVIEWED BY ANY HUMAN.** It was produced end-to-end by
DeepSeek V4.1-flash, an AI agent running in DeepSeek Harness, under human direction and approval; no
human has read, reviewed, audited or approved it. Verify anything here before you rely on it.

## 1. Does the fix leak write authority outside the workspace?

**No.** Escape probe executed *inside* the confined child, with the fix applied, mode `workspace-write`:

```
DENIED   C:\Users\<user>\dsh-escape-probe.txt                     (user profile root, drive C:)
DENIED   C:\dsh-escape-probe.txt                                  (drive root of C:)
DENIED   C:\WINDOWS\Temp\dsh-escape-probe.txt                     (system temp)
DENIED   C:\Users\<user>\AppData\Local\Temp\dsh-escape-probe.txt  (user temp, literal path)
ALLOWED  <workspace>\inside-ok.txt                                (inside the workspace, expected)
note: TMP/TEMP inside the sandbox = <session private temp> (granted by design; not an escape target)
```

Independently confirmed on the filesystem afterwards:

| path | exists |
|---|---|
| `C:\Users\<user>\dsh-escape-probe.txt` | **False** |
| `C:\dsh-escape-probe.txt` | **False** |
| `C:\WINDOWS\Temp\dsh-escape-probe.txt` | **False** |
| `C:\Users\<user>\AppData\Local\Temp\dsh-escape-probe.txt` | **False** |
| `<workspace>\inside-ok.txt` | **True** |

The write boundary is intact: **outside denied and absent, inside allowed.**

> `TMP`/`TEMP` are intentionally not used as an escape target: under `workspace-write` the runner
> rewrites them to the session's private temp directory, which the sandbox grants. `scripts/escape-test.ps1`
> therefore probes the *literal* user temp path.

## 2. What the change actually is

| | shipped | with this bundle |
|---|---|---|
| runner argv | `[execPath, runner.js, …profile, --, target]` | `[execPath, --import <shim>, runner.js, …profile, --, target]` |
| runner console | none (Electron is a GUI-subsystem image) | one (`AllocConsole()` in the runner process) |
| restricted token | Low IL + write-restricted SIDs | **identical** |
| workspace / temp grants, deny ACEs | as materialized by the seam | **identical** |
| integrity label, Job object, stdio | as shipped | **identical** |
| runner / child environment | as shipped | **identical — nothing injected** |
| fs policy (`dsh-fs-sandbox`) | shipped | **untouched** |

`console-shim.mjs` makes exactly one API call — `AllocConsole()` when `GetConsoleWindow()` is null —
and swallows every error. It performs no file access, no process creation and no environment change.

## 3. The failure matrix

All rows: the shipped ACL runner + its restricted token, child `pwsh.exe 7.6.6` invoked as
`-NoLogo -NoProfile -Command "exit 7"`. `3221225794` = `0xC0000142` = `STATUS_DLL_INIT_FAILED`.

| ACL runner host | mode | console shim | confined child exit |
|---|---|---|---|
| `node.exe` | read-only | – | `7` ✅ |
| `node.exe` | workspace-write | – | `7` ✅ |
| Electron | read-only | – | `7` ✅ |
| **Electron** | **workspace-write** | – | **`3221225794`** ❌ |
| Electron | read-only | yes | `7` ✅ |
| **Electron** | **workspace-write** | **yes** | **`7`** ✅ |
| Electron, full subprocess-runner chain | workspace-write | – | `3221225794` ❌ |
| Electron, full subprocess-runner chain | workspace-write | yes | `7` ✅ |

Reading of the matrix:

* The failure needs **both** conditions: a **console-less host** (the Electron binary) **and**
  `workspace-write`. `read-only` is not affected in practice, because the child's own console
  creation happens to succeed there.
* A console supplied to the runner fixes **both** modes, so the fix is not mode-specific.
* The full subprocess-runner chain behaves exactly like the direct spawn — the chain is not part of
  the cause, so the failure reproduces with the simpler direct invocation.

## 4. Console ownership measurement

```powershell
node scripts/console-probe.cjs                    # -> {"hasConsole":true, "consoleHwnd":"3213734", …}
node scripts/console-probe.cjs --host electron --electron '<DeepSeek Harness.exe>'
                                                  # -> {"hasConsole":false,"consoleHwnd":"0", …}
```

Both runs share the same parent process, so the difference is the image subsystem: `node.exe` is a
console-subsystem image, `DeepSeek Harness.exe` is a GUI-subsystem image. A GUI-subsystem child of a
console-owning parent still reports no console, and `CREATE_NEW_CONSOLE` does not give it one — so
"launch the app from a terminal" is not a workaround.

## 5. Ruled out by direct test

| Variable | Result |
|---|---|
| shell: `pwsh 7.6.6` (MSI), Store-packaged `pwsh`, `pwsh` from `PATH`, `powershell.exe` 5.1, `cmd.exe` | same outcome; not shell-specific |
| workspace / temp path: ASCII, spaces, CJK characters, `%TEMP%`, the real workspace path | no effect |
| runner working directory (`<session workspace>`, a neutral temp dir, `C:\Windows\Temp`, the temp root) | no effect |
| `TMP`/`TEMP` values (including a non-writable and a missing directory) | no effect |
| private temp creation / grants: agentless vs seam-managed (`--write-sid` + `--temp-write-sid`) | both fail in `workspace-write`; not the temp bookkeeping |
| fd 7 control channel on / off | no effect |
| `windowsHide: true` on the subprocess runner | no effect |
| host creation flags: `0`, `CREATE_NO_WINDOW`, `DETACHED_PROCESS` | no effect for a `node.exe` host (console either way); the Electron host gets no console with any of them |
| `diagnose-windows-sandbox-acl` on the `pwsh` install path | `VERDICT=NOT_THIS_CLASS`, 0 repairs — the path's ACLs are fine |
| Windows Application / WER log around the failure window | no entry (process-init failures produce none) |

Not isolated: the precise reason the child's *own* console creation succeeds under `read-only` but
fails under `workspace-write` (the two differ only in the capability SIDs carried by the restricted
token and in the private-temp bookkeeping; the latter is excluded above). This does not affect the
finding or the fix — supplying a console removes the need to create one in either mode.

## 6. Reproducing these results

See [`../scripts/README.md`](../scripts/README.md). The scripts need a copy of the Harness's sandbox
runner reachable as real files (the packaged app keeps it inside `app.asar`); `scripts/extract-asar.cjs`
extracts it.

## 7. Bundle-spec compliance

Audited against the Harness's own `cordis-plugin-development` and `cordis-composition-reference`
references. Three violations were found and fixed **before** this bundle was published:

| Rule | Was | Now |
|---|---|---|
| A non-insert patch with an `id` targets that row, and a truthy `name` **asserts** the existing plugin name instead of renaming it | the patch tried to swap the provider with `- id: sandbox` + `name: <this package>` — the loader warns and skips such a target, so the plugin would never have mounted | the patch **disables** the shipped `sandbox` row and **inserts** this package as its replacement (`id: sandbox-console-fix`), so the composition still has exactly one `ctx.sandbox` provider |
| A Host-only bundle declares **no dependencies** on dsh-shipped packages, which resolve from the dsh installation | `peerDependencies: @deepseek-ai/dsh-sandbox-local` | no dependencies at all — `index.js` resolves the base class from the running Harness bundle, and the shim resolves `koffi` there too |
| Display text lives in `locale/*.json`; the icon is a top-level `icon` | `meta` inside `package.json` | `locale/en.json`, `locale/zh.json`, `icon.svg`, with `exports` and `files` covering them |

The inserted row mirrors the shipped row's metadata exactly: the shipped row
(`@deepseek-ai/dsh-base/cordis.patch.yml`) is `id: sandbox` + `name: '@deepseek-ai/dsh-sandbox-local'`
with no `config`, `inject` or `isolate`, and this bundle's row declares none either. The profile's own
`cordis.patch.yml` does not target the `sandbox` row, so disabling it drops no user configuration.

`scripts/validate-manifests.cjs` asserts all three rules, so a regression fails `npm run check`.

## 8. Scope of this record

* ✅ verified: the injection mechanism, this repository's shim, the "confinement intact" property, the
  failure matrix, this bundle's compliance with the Harness's plugin/bundle rules (section 7), and the
  syntax/manifest validity of every file in this repository.
* ✅ verified locally: the package loads under the Harness Electron binary and resolves its base class
  from the running Harness bundle (`LOADED class=ConsoleFixSandboxProvider`).
* ✅ verified in a live session: installed through the Harness's own `plugin_manager` and confirmed in a
  real `workspace-write` session on the packaged app — see section 9.

## 9. Live end-to-end verification (real desktop app)

Performed after installing this bundle with the Harness's own installer (`install_bundle`), which wrote
`"dsh-sandbox-console-fix": "link:…"` into the profile's `dependencies` and added it to
`dsh.profile.bundles`; its pnpm log recorded `Packages: +1`, zero downloads and **no pending build
scripts**. The app was then restarted, and the session sandbox was set to `workspace-write`:

| Check | Result |
|---|---|
| confined child starts at all | ✅ `pwsh 7.6.6` — the same call produced `0xC0000142` before this bundle existed |
| in-workspace write | ✅ succeeds |
| out-of-workspace write (`%USERPROFILE%\dsh-postfix-probe.txt`) | ✅ `Access to the path … is denied.`, and the file is absent afterwards |
| deleting files in the user temp dir from the confined session | ✅ denied (`Access to the path 'C:\Users\<user>\AppData\Local\Temp\…' is denied.`) |
| `git` against a repository outside the session workspace | ✅ denied by the sandbox (no config/lock writes) |
| runner argv observed from inside the child | ❌ not observable — `Get-CimInstance Win32_Process` is denied under the restricted token |
| console handle from inside the child | ❌ inconclusive — `[Console]::WindowWidth` throws because the child's stdio are pipes, which happens with or without a console |

So the availability fix and the "confinement intact" property are confirmed **in a real session on the
packaged app**, not only against extracted sandbox code. The causal link to this bundle rests on (a) the
composition change applied at restart (verified against the profile's own patch layer and layer order)
and (b) the identical call failing before the bundle existed. Disabling the bundle and restarting is the
falsification test.

The precise reason the child's console initialization succeeds once the **runner** has a console is still
not isolated (section 5); the probe above cannot decide it, because redirected stdio hides the console
either way.

## 10. Platform guard and known trade-offs

* Both patch rows are platform-guarded with the Loader's `!!js` dialect — the same idiom the shipped
  `dsh-base` patch uses for its own `bash-sandbox` row:
  `- id: sandbox` / `disabled: !!js process.platform === 'win32'`, and this bundle's row with
  `disabled: !!js process.platform !== 'win32'`. Off Windows the shipped provider stays enabled, this
  bundle's row stays disabled, and the package is inert.
* **The guarded form is verified live too.** After the guard was added, the app was restarted at
  23:53:06, later than the patch's last write (23:34:40), and a `workspace-write` session then ran
  `pwsh 7.6.6` normally — with writes to `%USERPROFILE%`, the drive root and `C:\Windows\Temp` all
  denied and absent. A guarded patch the Loader had rejected could not have disabled the shipped row,
  so a working shell proves the `!!js` expression was evaluated and the swap happened.
* `AllocConsole()` also (re)initializes the process's standard handles for the new console. **Measured in
  the live `workspace-write` session:** 5,000 lines of stdout arrived intact (tail marker checked), the
  child's stderr arrived on its own channel (20 lines plus a tail marker), CJK text round-tripped through
  both, and a child process started from the confined shell worked — so the child's plumbing is
  unaffected. The residual, still-unmeasured case is a diagnostic written by the **runner itself** to
  stdout/stderr, which could land in the console instead of the Harness log; the runner has no
  diagnostics on the success path.
* **Piped stdio inside the confined shell is blocked** — the sandbox's documented confinement, not this
  bundle: a program inside `workspace-write` or `read-only` cannot capture another program's output
  through a pipe, so `$x = & some.exe …` and `some.exe | Out-Null` fail (`EPERM`, which PowerShell
  surfaces as `StandardOutputEncoding is only supported when standard output is redirected`), while a
  bare `& some.exe …`, PowerShell's own cmdlet pipelines and file redirection work. This is why the
  reproduction scripts must run outside a confined shell.






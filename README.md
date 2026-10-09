# dsh-sandbox-console-fix

> **Windows only.** A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that
> makes the confined sandbox usable on the desktop app: `workspace-write` shell calls start again, and
> `read-only` keeps working — **without relaxing any confinement**. Both of this bundle's patch rows are
> platform-guarded, so on Linux/macOS the composition is untouched and the package is inert.
>
> **Targets DeepSeek Harness desktop `0.2.0-rc.2`** — Electron 44.0.0 / Node 24.18.1, verified on
> Windows 11 22H2 x64.
> Reported upstream as a Discussion:
> <https://github.com/deepseek-ai/deepseek-harness/discussions/9280>.
> # ⚠️ NOT REVIEWED BY ANY HUMAN
>
> **AI-generated code.** Found, designed, written and tested end-to-end by **DeepSeek V4.1-flash**, an AI
> agent running in DeepSeek Harness. A human directed the work and approved the steps, but **no human has
> read, reviewed, audited or approved this code or its evidence**. Treat it exactly like unreviewed
> third-party code from an unknown author: read `index.js`, `console-shim.mjs` and `cordis.patch.yml`
> yourself before installing, and do not run it anywhere you would not run an unreviewed script.

## The problem

On the packaged Windows desktop app, any shell call under **`workspace-write`** fails immediately:

```
[exit code: 3221225794]        # 0xC0000142 STATUS_DLL_INIT_FAILED
```

`pwsh`, `cmd` and `powershell` all fail the same way, both MSI and Store-packaged PowerShell builds,
while `danger-full-access` **and `read-only`** work — so the shell tool is fine and the
**`workspace-write` confinement path** is the problem.

The failure needs two conditions together — a **console-less runner host** (the Electron binary) and
`workspace-write`. The complete matrix is in [`docs/VERIFICATION.md`](docs/VERIFICATION.md#3-the-failure-matrix). Why the child's own console creation succeeds in the one mode and fails in the other is **not isolated** — see sections 5 and 9 of that record; the fix works in both modes either way.

Root cause, in the shipped code (`dsh-sandbox-local`, `windowsAclRunnerInvocation()`):

```js
if (existsSync(builtEntry)) return [process.execPath, builtEntry];
```

In the desktop app `process.execPath` is **`DeepSeek Harness.exe`** — an **Electron binary, i.e. a
GUI-subsystem image, which never has a console**. Measured on one machine, same parent process:

| runner host | `GetConsoleWindow()` |
|---|---|
| `node.exe` (console subsystem) | non-zero → has a console |
| `DeepSeek Harness.exe` (GUI subsystem) | `0` → no console |

The ACL runner then spawns the confined child **without** `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`
— on purpose, because per DSH's own documentation such children die during DLL initialization under
the restricted token — and relies on the child **inheriting the runner's console**. With nothing to
inherit, the console-subsystem child must create a console itself; that creation fails under the
Low-integrity write-restricted token, and the process exits `STATUS_DLL_INIT_FAILED` (`0xC0000142`).

## The fix

One extra argv entry, in the position DSH's **own development path** already uses for the same runner
(`[process.execPath, "--import", <url>, entry]`):

```
shipped:  [execPath, runner.js, …profile, --, target]
this:     [execPath, --import <console-shim.mjs>, runner.js, …profile, --, target]
```

`console-shim.mjs` calls `AllocConsole()` when the process has no console, and nothing else, so the
confined child inherits a console and starts normally.

### What does **not** change

| | shipped | with this bundle |
|---|---|---|
| restricted token (Low IL + write-restricted SIDs) | ✔ | **identical** |
| workspace / private-temp capability-SID grants, deny ACEs | ✔ | **identical** |
| integrity label, Job object, stdio plumbing, denial dialects | ✔ | **identical** |
| runner and child environment | ✔ | **identical — nothing injected** |
| `dsh-fs-sandbox` file policy | ✔ | **untouched** |

Verified with an escape-write test run *inside* the confined child: four out-of-workspace targets are
denied and absent on disk, while an in-workspace write succeeds — see
[`docs/VERIFICATION.md`](docs/VERIFICATION.md).

## Install

Install it the way dsh expects — through the **Plugin Manager**, which performs package installation
and bundle selection itself:

1. Open the Plugin Manager page and install a bundle from
   `https://github.com/TJZF-4j97/dsh-sandbox-console-fix`, or from an absolute path to a checkout of
   this directory.
2. Restart the Harness.
3. Set the session to `workspace-write` and run any shell command.

Nothing is downloaded and no build script is requested, because the package deliberately declares no
dependencies: `index.js` loads `LocalSandboxProvider` from the running Harness bundle, and
`console-shim.mjs` resolves `koffi` there too. The Harness's own installer recorded exactly that —
`Packages: +1`, zero downloads, no pending build scripts.

`cordis.patch.yml` mounts this provider by **disabling the shipped `sandbox` row and inserting its own**,
both rows platform-guarded with `!!js` — the idiom the shipped `dsh-base` patch uses for its own
`bash-sandbox` row. That shape is required by the Loader dialect: a non-insert patch that targets an
existing row replaces its fields, and a truthy `name` only *asserts* the existing plugin name, so a
provider row cannot be swapped by overriding its id. On Windows the composition keeps exactly one
`ctx.sandbox` provider and the shipped package still resolves from the dsh installation; on other
platforms the shipped row stays enabled and this bundle's row stays disabled.

<details>
<summary>Installing by hand (not recommended)</summary>

Copy the directory somewhere the profile can resolve, add the name to `dsh.profile.bundles`, then
restart:

```powershell
Copy-Item -Recurse -Force .\dsh-sandbox-console-fix "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-sandbox-console-fix"
```

```json
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-sandbox-console-fix"] } } }
```

The Plugin Manager route is preferred: `install_bundle` snapshots and restores `package.json` and
`pnpm-lock.yaml` when an install fails, and keeps the profile's own bookkeeping consistent.
</details>

## Verify

With the session set to `workspace-write`:

```powershell
$PSVersionTable.PSVersion                      # expect 7.6.6 — not 0xC0000142
Set-Content 'C:\Users\<you>\nope.txt' 'x'      # expect [sandbox: file access denied under workspace-write mode]
Set-Content '.\ok.txt' 'x'                     # expect success
Remove-Item '.\ok.txt'
```

> **Not caused by this bundle:** inside the confined shell the sandbox blocks piped stdio between
> programs, so `$x = & some.exe …` and `some.exe | Out-Null` fail (`EPERM`; PowerShell surfaces it as
> `StandardOutputEncoding is only supported when standard output is redirected`), while a bare
> `& some.exe …`, PowerShell's own cmdlet pipelines and file redirection work. That is the sandbox's
> documented confinement.
Reproduce the underlying mechanism without installing anything:

```powershell
node scripts/console-probe.cjs                        # host-console probe
node scripts/console-probe.cjs --host electron        # same parent, Electron host
node scripts/full-chain-repro.js --help               # drive the shipped runner under both hosts
powershell -File scripts/escape-test.ps1 -Workspace <dir>   # confinement check
```

See [`scripts/README.md`](scripts/README.md) for the extracted-runner paths those scripts need.

## Uninstall

Remove the bundle name from the profile's `bundles` list (and the dependency), then restart. No
system-level change is left behind — the workspace ACEs and integrity label that the Harness itself
owns are not touched by this bundle.

## Compatibility

| | |
|---|---|
| Platform | Windows 10/11, x64 |
| Harness | **DeepSeek Harness desktop `0.2.0-rc.2`** (Electron 44.0.0 / Node 24.18.1) — the subclass overrides one method of `@deepseek-ai/dsh-sandbox-local@0.2.0-rc.2` |
| Node / Electron | any (`--import` requires Node ≥ 20.6 / Electron with Node ≥ 20.6) |
| Upstream report | <https://github.com/deepseek-ai/deepseek-harness/discussions/9280> |
| Other platforms | the override is never called; the package is inert |

Because it subclasses a Harness-internal class, re-check after a Harness upgrade — the upstream fix
(see the issue report) makes this package unnecessary.

## Discovery

DeepSeek Harness's [CONTRIBUTING.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md)
asks ecosystem plugins to associate their GitHub project with the **`dsh-plugin`** topic. This
repository carries it — together with `dsh`, `deepseek-harness`, `sandbox`, `windows` and `pwsh` — so
the plugin is discoverable from that topic listing.

## Security

The bundle does not widen file authority. It only lets the runner allocate a console; the write
boundary still comes from the restricted token, the write-restricted SIDs, the Low integrity label and
the Harness's ACL grants and denies, all inherited unchanged. The shim performs no file access, no
process creation and no environment change, and swallows every error.

## License

[MIT](LICENSE)






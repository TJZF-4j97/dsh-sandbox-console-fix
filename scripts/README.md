# Reproduction scripts

These scripts drive the **shipped** sandbox code, so they need the Harness's sandbox runner and its
dependencies as real files. The packaged app keeps them inside `app.asar`, which plain `node` cannot
import — extract them first.

> **Run these from an unconfined shell.** Inside a `workspace-write` or `read-only` shell the sandbox
> blocks piped stdio between programs, so a Node script that spawns with `stdio: 'pipe'` — these scripts,
> and anything else that captures another program's output — fails with `EPERM`. Use a normal terminal,
> or a `danger-full-access` session, for the reproductions below.
## 1. Extract the runner (once)

```powershell
$app  = 'C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness'
node scripts/extract-asar.cjs "$app\resources\app.asar" .\vendor `
  "dsh-(sandbox-windows-acl|sandbox-local|subprocess|subprocess-local|win32-process|lazy-require|skill)/|/yaml/|/koffi/"

# native modules live outside the archive
robocopy "$app\resources\app.asar.unpacked" .\vendor /E | Out-Null
```

You should now have:

```
vendor/dsh/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js
vendor/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner.js
vendor/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js
vendor/dsh/node_modules/koffi/…
```

## 2. Console ownership probe

```powershell
node scripts/console-probe.cjs --koffi .\vendor\dsh\node_modules\koffi
node scripts/console-probe.cjs --koffi .\vendor\dsh\node_modules\koffi `
     --host electron --electron "$app\DeepSeek Harness.exe"
```

Expected: the `node` host reports `"hasConsole": true`; the Electron host reports
`"hasConsole": false, "consoleHwnd": "0"` from the **same parent process**.

## 3. Full chain reproduction

```powershell
$sub  = '.\vendor\dsh\node_modules\@deepseek-ai\dsh-subprocess-local\lib\runner.js'
$acl  = '.\vendor\dsh\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js'
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'

# The failure needs the Electron host AND workspace-write.

# a) node host, workspace-write — works
node scripts/full-chain-repro.js --sub-runner $sub --acl-runner $acl `
  --workspace .\work --temp .\work-tmp --mode workspace-write --host node `
  -- $pwsh -NoLogo -NoProfile -Command "exit 7"
# -> "childExit": 7

# b) Electron host, read-only — also works (no fault to reproduce)
node scripts/full-chain-repro.js --sub-runner $sub --acl-runner $acl `
  --workspace .\work --temp .\work-tmp --mode read-only --host electron `
  --electron "$app\DeepSeek Harness.exe" `
  -- $pwsh -NoLogo -NoProfile -Command "exit 7"
# -> "childExit": 7

# c) Electron host, workspace-write — reproduces the bug
node scripts/full-chain-repro.js --sub-runner $sub --acl-runner $acl `
  --workspace .\work --temp .\work-tmp --mode workspace-write --host electron `
  --electron "$app\DeepSeek Harness.exe" `
  -- $pwsh -NoLogo -NoProfile -Command "exit 7"
# -> "childExit": 3221225794   (0xC0000142)

# d) Electron host, workspace-write + the console shim — fixed
node scripts/full-chain-repro.js --sub-runner $sub --acl-runner $acl `
  --workspace .\work --temp .\work-tmp --mode workspace-write --host electron `
  --electron "$app\DeepSeek Harness.exe" --import-shim "file:///abs/path/console-shim.mjs" `
  -- $pwsh -NoLogo -NoProfile -Command "exit 7"
# -> "childExit": 7, and the shim's AllocConsole() ran inside the runner
```

## 4. Confinement check (the security question)

Run the escape probe as the confined child in `workspace-write` mode, then read the report the child
wrote inside the workspace:

```powershell
New-Item -ItemType Directory -Force .\work, .\work-tmp | Out-Null
node scripts/full-chain-repro.js --sub-runner $sub --acl-runner $acl `
  --workspace "$PWD\work" --temp "$PWD\work-tmp" --mode workspace-write --host electron `
  --electron "$app\DeepSeek Harness.exe" --import-shim "file:///abs/path/console-shim.mjs" `
  -- pwsh -NoLogo -NoProfile -File "$PWD\scripts\escape-test.ps1" -Workspace "$PWD\work"

Get-Content .\work\escape-report.txt          # DENIED for every outside target, ALLOWED inside
Test-Path "$env:USERPROFILE\dsh-escape-probe.txt"   # must be False
```

## 5. Structural check

```powershell
npm run check     # node --check + scripts/validate-manifests.cjs
```

## Notes

* `--mode workspace-write` without `--write-sid`/`--temp-write-sid` is the runner's *agentless* mode:
  it creates and grants its own private temp directory, exactly like the seam does.
* Passing both `--write-sid` and `--temp-write-sid` reproduces the seam-managed mode; the SIDs are
  derived from the paths (`workspaceWriteSid`, `tempWriteSid`).
* The scripts never modify a system setting; they only start processes and write under the directories
  you pass them.


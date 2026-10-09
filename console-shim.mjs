// Preloaded (via --import) into the Windows ACL sandbox runner process only.
//
// It gives that process a console when it has none. The confined child is a
// console-subsystem image (pwsh, cmd, powershell), so it starts without having
// to create a console itself — that creation is what fails with 0xC0000142 under
// the restricted token. Which step this actually repairs is NOT isolated; see
// docs/VERIFICATION.md sections 5 and 9.
//
// Why the three standard handles are restored
// -------------------------------------------
// AllocConsole() re-initializes the process's standard handles for the new
// console, which would send the runner's OWN stdout/stderr to that console
// instead of back to the Harness. Measured: the handles change (e.g.
// 1816/1624/1700 -> 712/716/720). So they are saved, the console is allocated,
// and they are put back. This is the remedy measured in the Harness discussions
// #8193/#8208 and named by `@argszero/cordis-plugin-sandbox-grant-advisor` (its
// `native-init` family): "AllocConsole before the restricted spawn ... with the
// three standard handles restored afterwards".
//
// Restoring them cannot affect the confined child: the runner hands the child
// its own CRT carrier descriptors (stdin/stdout/stderr plus the fd-7 control
// pipe) through STARTUPINFO.cbReserved2/lpReserved2 and STARTF_USESTDHANDLES —
// see @deepseek-ai/dsh-win32-process/README.md — so the child never depends on
// slots 0/1/2.
//
// Why the new window is hidden
// ----------------------------
// A console allocated in a process that was not spawned with SW_HIDE is VISIBLE
// (measured: `IsWindowVisible(GetConsoleWindow()) === true`, window title = the
// host image path). The shipped runner is spawned with STARTF_USESHOWWINDOW +
// SW_HIDE, so it stays hidden there, but this shim hides the window it creates
// anyway so the bundle can never flash a window on a desktop. An ALREADY
// existing console is left exactly as it was (nothing happens unless
// GetConsoleWindow() is null), so a developer running from a terminal keeps
// their console.
//
// It deliberately does nothing else: no file access, no process creation, no
// environment change, no token/ACL/label work. Any failure is swallowed so the
// runner keeps its shipped behaviour.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require_ = createRequire(import.meta.url);

const STD_INPUT_HANDLE = -10;
const STD_OUTPUT_HANDLE = -11;
const STD_ERROR_HANDLE = -12;
const STANDARD_HANDLES = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE];
const SW_HIDE = 0;

/** koffi from the profile, else the copy bundled inside the running Harness. */
function loadKoffi() {
  try {
    return require_('koffi');
  } catch {
    /* fall through to the bundled copy */
  }
  const resources = process.resourcesPath;
  if (!resources) return undefined;
  const bundled = resources + '/app.asar/dsh/node_modules/koffi';
  try {
    return existsSync(bundled) ? require_(bundled) : undefined;
  } catch {
    return undefined;
  }
}

try {
  const koffi = loadKoffi();
  if (koffi !== undefined) {
    const kernel32 = koffi.load('kernel32.dll');
    const user32 = koffi.load('user32.dll');
    const GetConsoleWindow = kernel32.func('void *GetConsoleWindow()');
    const AllocConsole = kernel32.func('int AllocConsole()');
    const GetStdHandle = kernel32.func('void *GetStdHandle(int nStdHandle)');
    const SetStdHandle = kernel32.func('int SetStdHandle(int nStdHandle, void *hHandle)');
    const ShowWindow = user32.func('int ShowWindow(void *hWnd, int nCmdShow)');
    if (!GetConsoleWindow()) {
      const saved = STANDARD_HANDLES.map((n) => [n, GetStdHandle(n)]);
      AllocConsole();
      for (const [n, handle] of saved) {
        if (handle) SetStdHandle(n, handle);
      }
      const created = GetConsoleWindow();
      if (created) ShowWindow(created, SW_HIDE);
    }
  }
} catch {
  // No console shim available: the runner keeps its shipped behaviour.
}

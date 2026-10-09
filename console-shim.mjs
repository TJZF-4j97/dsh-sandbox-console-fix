// Preloaded (via --import) into the Windows ACL sandbox runner process only.
//
// It gives that process a console when it has none. The confined child is a
// console-subsystem image (pwsh, cmd, powershell), so it starts without having
// to create a console itself — that creation is what fails with 0xC0000142 under
// the restricted token. Which step this actually repairs is NOT isolated; see
// docs/VERIFICATION.md sections 5 and 9.
//
// It deliberately does nothing else: no file access, no process creation, no
// environment change, no token/ACL/label work. Any failure is swallowed so the
// runner keeps its shipped behaviour.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require_ = createRequire(import.meta.url);

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
    const GetConsoleWindow = kernel32.func('void *GetConsoleWindow()');
    const AllocConsole = kernel32.func('int AllocConsole()');
    if (!GetConsoleWindow()) AllocConsole();
  }
} catch {
  // No console shim available: the runner keeps its shipped behaviour.
}


import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const pluginDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * Is a resolved module path inside a directory this bundle is willing to load code from?
 *
 * A bare `require('@deepseek-ai/dsh-sandbox-local')` walks this plugin's ancestor directories,
 * every one of which is writable by any process running as this user. A planted copy would
 * execute inside the Harness process, and the class it returns controls
 * `windowsAclRunnerInvocation()` — it could hand back an argv with no runner at all, which is
 * the sandbox switched off. Only this plugin's own node_modules, or the dsh profile root, is
 * trusted to supply that package.
 */
function isTrustedLocalInstall(resolvedPath) {
  let real;
  try {
    real = realpathSync(resolvedPath);
  } catch {
    return false;
  }
  const normalized = real.replace(/\\/g, '/').toLowerCase();
  const ownModules = (pluginDir + 'node_modules/').replace(/\\/g, '/').toLowerCase();
  if (normalized.startsWith(ownModules)) return true;
  const profileRoot = (homedir() + '/.dsh/profiles/').replace(/\\/g, '/').toLowerCase();
  return normalized.startsWith(profileRoot) && normalized.includes('/node_modules/');
}

/** The console shim, resolved next to this file so the URL survives packaging. */
const shimUrl = new URL('./console-shim.mjs', import.meta.url).href;

/**
 * Load `LocalSandboxProvider` from the **running Harness bundle** first.
 *
 * That order is the point: the Harness already mounts its own copy as the
 * `sandbox` row, so subclassing exactly that copy keeps one identical class in
 * the composition — and it makes this bundle dependency-free, so installing it
 * needs no `pnpm install`, no build script approval and no peer closure from npm.
 *
 * A local install is only a fallback for development, tests, or a Harness copy
 * that is not reachable through `process.resourcesPath`.
 *
 * @returns the loaded module namespace and where it came from.
 * @throws when neither the Harness copy nor a local install can be loaded.
 */
function loadLocalSandboxProvider() {
  const attempted = [];
  const resources = process.resourcesPath;
  const candidates = [];
  if (typeof resources === 'string' && resources.length > 0) {
    candidates.push(`${resources}/app.asar/dsh/node_modules/@deepseek-ai/dsh-sandbox-local`);
    candidates.push(`${resources}/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-sandbox-local`);
  }
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) {
        attempted.push(`${candidate} (absent)`);
        continue;
      }
      return { module: require_(candidate), from: candidate };
    } catch (error) {
      attempted.push(`${candidate} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  try {
    const resolved = require_.resolve('@deepseek-ai/dsh-sandbox-local');
    if (!isTrustedLocalInstall(resolved)) {
      throw new Error('refusing to load it from ' + resolved);
    }
    return { module: require_(resolved), from: resolved };
  } catch (error) {
    attempted.push(
      `node_modules/@deepseek-ai/dsh-sandbox-local (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  throw new Error(
    'dsh-sandbox-console-fix could not load @deepseek-ai/dsh-sandbox-local. Tried: ' +
      attempted.join(' | ') +
      '. This bundle expects to run inside DeepSeek Harness; outside it, install that package locally.',
  );
}

const loaded = loadLocalSandboxProvider();
const LocalSandboxProvider = loaded.module.default ?? loaded.module.LocalSandboxProvider;
if (typeof LocalSandboxProvider !== 'function') {
  throw new Error(
    `dsh-sandbox-console-fix: ${loaded.from} did not export LocalSandboxProvider (default or named).`,
  );
}

/**
 * Why this exists
 * ---------------
 * On Windows the shipped bundle spawns the ACL sandbox runner with
 * `process.execPath` — in the packaged desktop app that is the Electron binary,
 * which is a GUI-subsystem image and therefore has NO console. The ACL runner
 * spawns the confined child without any console-isolation flag on purpose (a
 * CREATE_NO_WINDOW / CREATE_NEW_CONSOLE child dies under the restricted token),
 * so the confined child is expected to INHERIT the runner's console. With no
 * console to inherit, the child (pwsh/cmd/powershell are console-subsystem
 * images) must create one; that creation fails under the restricted token in
 * `workspace-write`, and the process dies with STATUS_DLL_INIT_FAILED
 * (0xC0000142).
 *
 * The fix keeps every confinement decision exactly as shipped and only inserts
 * `--import <console-shim>` before the runner entry, so the shim runs in the runner process: it first merges an `Everyone` ACE into the runner token
 * Default DACL, and only falls back to AllocConsole() when it cannot. The child then starts.
 * Which step this actually repairs is not isolated — see docs/VERIFICATION.md sections 5 and 9.
 *
 * What this does NOT change
 * -------------------------
 * - the restricted token (Low integrity + write-restricted SIDs)
 * - the workspace / private-temp capability-SID Write grants and the standing deny ACEs
 * - the integrity label, the Job object, the stdio plumbing, the denial dialects
 * - the environment of the sandbox runner or of the confined child (nothing is injected there)
 */
export class ConsoleFixSandboxProvider extends LocalSandboxProvider {
  /**
   * Same invocation as the shipped provider, with the shim preloaded in front of
   * the runner entry. `--import` sits where the shipped development path already
   * puts it, so the runner contract is unchanged.
   * @returns the ACL runner argv prefix for the current policy.
   */
  windowsAclRunnerInvocation() {
    const base = super.windowsAclRunnerInvocation();
    if (!Array.isArray(base) || base.length === 0) return base;
    if (!existsSync(fileURLToPath(shimUrl))) {
      // A preload the runner cannot read makes the runner fail to start, which breaks EVERY
      // sandboxed command. Losing the fix is bad; breaking the shell is worse.
      console.warn('dsh-sandbox-console-fix: console-shim.mjs is missing; running without the fix');
      return base;
    }
    return [base[0], '--import', shimUrl, ...base.slice(1)];
  }
}

export default ConsoleFixSandboxProvider;



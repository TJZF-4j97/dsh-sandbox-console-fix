import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require_ = createRequire(import.meta.url);

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
    return {
      module: require_('@deepseek-ai/dsh-sandbox-local'),
      from: 'node_modules/@deepseek-ai/dsh-sandbox-local',
    };
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
 * `--import <console-shim>` before the runner entry, so the runner process calls
 * AllocConsole() once at startup. The confined child then starts normally.
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
    return [base[0], '--import', shimUrl, ...base.slice(1)];
  }
}

export default ConsoleFixSandboxProvider;


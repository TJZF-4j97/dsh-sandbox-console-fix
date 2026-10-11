#!/usr/bin/env node
// Structural validation with no dependencies. It encodes the DSH bundle rules this
// package must keep satisfying (see the `cordis-plugin-development` and
// `cordis-composition-reference` skills):
//
//   * package.json parses and carries the fields a Host-only bundle needs;
//   * `dsh.bundle.patch` resolves, and the patch uses the Loader dialect
//     correctly: a non-insert patch with an `id` targets that row and a truthy
//     `name` ASSERTS the existing plugin name instead of renaming it, so a
//     provider row is swapped by disabling the shipped `sandbox` row and
//     inserting this package as its replacement — never by overriding its id;
//   * no dependency is declared on dsh-shipped packages, because those resolve
//     from the dsh installation;
//   * every path the manifest promises exists, and the two code files still
//     contain the behaviour the README claims.
'use strict';

const { readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const failures = [];

function ok(message) {
  console.log('ok   ' + message);
}
function fail(message) {
  failures.push(message);
  console.error('FAIL ' + message);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  ok('package.json parses');
} catch (error) {
  fail('package.json: ' + error.message);
  process.exit(1);
}

for (const field of ['name', 'version', 'description', 'license']) {
  if (typeof manifest[field] === 'string' && manifest[field].length > 0) ok(`package.json has ${field}`);
  else fail(`package.json is missing ${field}`);
}

const shipped = [];
for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  const declared = manifest[field];
  if (!declared || typeof declared !== 'object') continue;
  for (const name of Object.keys(declared)) {
    if (name.startsWith('@deepseek-ai/')) shipped.push(`${field}.${name}`);
  }
}
if (shipped.length === 0) {
  ok('declares no dependency on dsh-shipped packages (they resolve from the dsh installation)');
} else {
  fail('declares dependencies on dsh-shipped packages: ' + shipped.join(', '));
}

const patchRel = manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch;
if (typeof patchRel === 'string') {
  ok('package.json declares dsh.bundle.patch');
  const patchPath = join(root, patchRel);
  if (!existsSync(patchPath)) {
    fail('bundle patch is missing: ' + patchRel);
  } else {
    const patch = readFileSync(patchPath, 'utf8');
    const lines = patch.split(/\r?\n/);

    let disablesSandbox = false;
    let renamesSandbox = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^-\s*id:\s*sandbox\s*$/.test(lines[i])) continue;
      for (let j = i + 1; j < lines.length && !/^-\s/.test(lines[j]); j += 1) {
        if (/^\s*disabled:\s*(?:true|!!js\s+.*process\.platform.*)\s*$/.test(lines[j])) disablesSandbox = true;
        if (/^\s*(name|id):/.test(lines[j])) renamesSandbox = true;
      }
    }
    if (disablesSandbox) ok('bundle patch disables the shipped `sandbox` row');
    else fail('bundle patch does not disable the shipped `sandbox` row');
    if (renamesSandbox) {
      fail('bundle patch tries to rename the shipped row (a truthy `name` only asserts its name)');
    } else {
      ok('bundle patch does not attempt to rename the shipped row');
    }

    const insertIndex = lines.findIndex((line) => /^-\s*insert:\s*$/.test(line));
    if (insertIndex >= 0) {
      ok('bundle patch has an `insert:` block');
      const inserted = lines.slice(insertIndex).join('\n');
      if (inserted.includes(manifest.name)) ok('inserted row names this package');
      else fail('inserted row does not name this package (' + manifest.name + ')');
      if (/^\s*-\s*id:\s*sandbox-console-fix\s*$/m.test(inserted)) {
        ok('inserted row uses the unique id `sandbox-console-fix`');
      } else {
        fail('inserted row does not use the unique id `sandbox-console-fix`');
      }
    } else {
      fail('bundle patch has no `insert:` block');
    }
  }
} else {
  fail('package.json is missing dsh.bundle.patch');
}

const promised = [
  'index.js',
  'console-shim.mjs',
  'cordis.patch.yml',
  'README.md',
  'docs/VERIFICATION.md',
  ...(Array.isArray(manifest.files) ? manifest.files : []),
];
for (const rel of [...new Set(promised)]) {
  if (rel.includes('*')) continue; // glob entries are covered by the explicit checks below
  if (existsSync(join(root, rel))) ok('present: ' + rel);
  else fail('missing: ' + rel);
}

// Display metadata belongs in locale/*.json, with the icon declared as a top-level
// `icon` in package.json (cordis-plugin-development, "Display metadata and icon").
for (const rel of ['icon.svg', 'locale/en.json', 'locale/zh.json']) {
  if (!existsSync(join(root, rel))) {
    fail('missing: ' + rel);
    continue;
  }
  if (rel.endsWith('.json')) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, rel), 'utf8'));
      if (parsed.meta && typeof parsed.meta.title === 'string' && typeof parsed.meta.description === 'string') {
        ok(`${rel} carries meta.title and meta.description`);
      } else {
        fail(`${rel} is missing meta.title or meta.description`);
      }
    } catch (error) {
      fail(`${rel}: ${error.message}`);
    }
  } else {
    ok('present: ' + rel);
  }
}
if (typeof manifest.icon === 'string' && manifest.icon.length > 0) ok('package.json declares a top-level icon');
else fail('package.json does not declare a top-level icon');

const shim = readFileSync(join(root, 'console-shim.mjs'), 'utf8');
if (shim.includes('SetEntriesInAclW') && shim.includes('TOKEN_DEFAULT_DACL')) ok('console-shim.mjs merges the runner token Default DACL');
else fail('console-shim.mjs does not merge the runner token Default DACL');
if (shim.includes('AllocConsole')) ok('console-shim.mjs calls AllocConsole');
else fail('console-shim.mjs does not call AllocConsole');
if (shim.includes('SetStdHandle')) ok('console-shim.mjs restores the standard handles');
else fail('console-shim.mjs does not restore the standard handles');
if (shim.includes('ShowWindow')) ok('console-shim.mjs hides the console window it creates');
else fail('console-shim.mjs does not hide the console window it creates');

const provider = readFileSync(join(root, 'index.js'), 'utf8');
if (provider.includes('windowsAclRunnerInvocation')) ok('index.js overrides windowsAclRunnerInvocation');
else fail('index.js does not override windowsAclRunnerInvocation');
if (provider.includes("'--import'")) ok("index.js inserts '--import'");
else fail("index.js does not insert '--import'");
if (provider.includes('resourcesPath')) ok('index.js resolves the base class from the Harness bundle');
else fail('index.js does not resolve the base class from the Harness bundle');

if (manifest.repository && typeof manifest.repository === 'object' && typeof manifest.repository.url === 'string') {
  ok('package.json declares repository');
} else {
  fail('package.json does not declare repository');
}
// Provenance: this package must keep stating that it is unreviewed AI-authored work.
if (typeof manifest.author === 'string' && manifest.author.includes('V4.1-flash') && /NOT REVIEWED BY ANY HUMAN/i.test(manifest.author)) {
  ok('package.json author names the AI agent and states it is not human-reviewed');
} else {
  fail('package.json author does not state the AI agent + unreviewed status');
}
{
  const readmeText = readFileSync(join(root, 'README.md'), 'utf8');
  if (readmeText.includes('NOT REVIEWED BY ANY HUMAN')) ok('README carries the NOT REVIEWED BY ANY HUMAN warning');
  else fail('README does not carry the NOT REVIEWED BY ANY HUMAN warning');
  for (const rel of ['locale/en.json', 'locale/zh.json']) {
    const localeText = readFileSync(join(root, rel), 'utf8');
    if (localeText.includes('V4.1-flash') && (localeText.includes('NOT REVIEWED') || localeText.includes('未经任何人工审查'))) {
      ok(rel + ' states the AI authorship and the unreviewed status');
    } else {
      fail(rel + ' does not state the AI authorship and unreviewed status');
    }
  }
}

// --- Hardening added after the 2026-10-11 adversarial review -------------------------------
// The checks above never looked at the INSERTED row's guard, never checked the POLARITY of the
// shipped row's guard, and only grepped for keywords in the shim. All three were real blind
// spots; these assertions close them and pin the security fixes in place.
{
  const patch = readFileSync(join(root, manifest.dsh.bundle.patch), 'utf8');
  const guardOf = (rowLine) => {
    const lines = patch.split(/\r?\n/);
    const start = lines.findIndex((line) => new RegExp('^\\s*-\\s*' + rowLine + '\\s*$').test(line));
    if (start < 0) return undefined;
    for (let i = start + 1; i < lines.length && !/^\s*-\s/.test(lines[i]); i += 1) {
      const m = /^\s*disabled:\s*(.+?)\s*$/.exec(lines[i]);
      if (m) return m[1];
    }
    return undefined;
  };
  const shippedGuard = guardOf('id:\\s*sandbox') ?? guardOf('id: sandbox');
  if (shippedGuard === undefined) fail('shipped `sandbox` row has no `disabled:` guard');
  else if (/^["']/.test(shippedGuard)) fail('shipped row guard is a quoted string literal: Boolean(non-empty string) is true, so it disables on every platform');
  else if (!/process\.platform\s*===\s*'win32'/.test(shippedGuard)) fail('shipped row guard is not the exact win32 polarity: ' + shippedGuard);
  else ok('shipped row guard is the exact win32 polarity');

  const insertedGuard = guardOf('id:\\s*sandbox-console-fix') ?? guardOf('id: sandbox-console-fix');
  if (insertedGuard === undefined) fail('inserted row has no `disabled:` guard (it would then be active on every platform)');
  else if (/^["']/.test(insertedGuard)) fail('inserted row guard is a quoted string literal: Boolean(non-empty string) is true, so it disables on every platform');
  else if (!/process\.platform\s*!==\s*'win32'/.test(insertedGuard)) fail('inserted row guard is not the exact non-win32 polarity: ' + insertedGuard);
  else ok('inserted row guard is the exact non-win32 polarity');
}
{
  // Module-resolution hijack guard: a bare `require('koffi')` walks writable ancestor directories
  // and would execute planted code inside the sandbox runner.
  if (/require_\(\s*'koffi'\s*\)/.test(shim)) fail("console-shim.mjs resolves koffi through a bare specifier (module-resolution hijack)");
  else ok('console-shim.mjs never resolves koffi through a bare specifier');
  if (shim.includes('writeFileSync')) fail('console-shim.mjs writes files (the diagnostic must not create arbitrary-path writes)');
  else ok('console-shim.mjs performs no file writes');
  if (shim.includes("process.arch !== 'x64'")) ok('console-shim.mjs refuses the 64-bit-only merge on other architectures');
  else fail('console-shim.mjs does not guard the 64-bit-only EXPLICIT_ACCESS_W layout');
  if (shim.includes('FILE_ALL_ACCESS')) ok('console-shim.mjs verifies the granted access mask');
  else fail('console-shim.mjs does not verify the granted access mask');
  if (shim.includes('CloseHandle') && shim.includes('LocalFree')) ok('console-shim.mjs releases the token handle, the SID and the merged ACL');
  else fail('console-shim.mjs leaks the token handle, the SID or the merged ACL');
}
{
  if (provider.includes('isTrustedLocalInstall')) ok('index.js validates where the base class is loaded from');
  else fail('index.js loads the base class from an unvalidated resolution');
  if (provider.includes('console-shim.mjs is missing')) ok('index.js refuses to preload a missing shim (a broken preload would break every command)');
  else fail('index.js injects the preload without checking that the shim exists');
}
console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('all structural checks passed');









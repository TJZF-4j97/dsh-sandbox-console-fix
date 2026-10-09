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
if (shim.includes('AllocConsole')) ok('console-shim.mjs calls AllocConsole');
else fail('console-shim.mjs does not call AllocConsole');

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

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('all structural checks passed');





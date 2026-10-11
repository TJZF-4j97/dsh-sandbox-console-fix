// Preloaded (via --import) into the Windows ACL sandbox runner process only.
//
// PRIMARY — restore the Default DACL the runner's restricted token is derived from.
// The restricted child dies in DLL initialization with 0xC0000142 in `workspace-write` when the
// runner owns no console, because the child must create a console of its own and the restricted
// token's Default DACL cannot authorize it. The shipped runner merges ONE full-access ACE into that
// Default DACL — `tempWriteSidPtr ?? writeSidPtr ?? worldSid` — so `read-only` lands `Everyone` and
// `workspace-write` lands the capability write SID. The Default DACL is inherited from THIS process's
// token, so merging `Everyone` here, before the runner derives the restricted token, restores exactly
// what `read-only` already gets.
//
// FALLBACK — give the runner a console (AllocConsole with the three standard handles saved/restored
// and the window hidden) when the merge cannot be applied. An existing console is left untouched.
//
// Resolution is deliberately deterministic: koffi is loaded ONLY from inside the running Harness
// installation. A bare `require('koffi')` would walk the plugin's ancestor directories (all writable
// by any process running as this user) and let planted code execute inside the runner process, which
// runs outside the sandbox.
//
// This module performs NO file writes. If DSH_SANDBOX_CONSOLE_FIX_DEBUG is set to any non-empty
// value, it emits one line on stderr naming the path that was taken.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require_ = createRequire(import.meta.url);

const TOKEN_QUERY = 0x0008;
const TOKEN_ADJUST_DEFAULT = 0x0080;
const TOKEN_DEFAULT_DACL = 6;
const FILE_ALL_ACCESS = 0x001f01ff;
const GRANT_ACCESS = 1;
const TRUSTEE_IS_SID = 0;
const TRUSTEE_IS_WELL_KNOWN_GROUP = 5;
const EXPLICIT_ACCESS_SIZE = 48; // matches the runner's own entries.length / 48
const EVERYONE_SID = 'S-1-1-0';

const STD_INPUT_HANDLE = -10;
const STD_OUTPUT_HANDLE = -11;
const STD_ERROR_HANDLE = -12;
const STANDARD_HANDLES = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE];
const SW_HIDE = 0;

const DEBUG = Boolean(process.env.DSH_SANDBOX_CONSOLE_FIX_DEBUG);
const trace = (message) => {
  if (!DEBUG) return;
  try {
    process.stderr.write('[dsh-sandbox-console-fix] ' + message + '\n');
  } catch {
    /* diagnostics only */
  }
};

/** koffi, from the running Harness installation only — never from a bare specifier. */
function loadKoffi() {
  const resources = process.resourcesPath;
  if (!resources) return undefined;
  const bundled = resources + '/app.asar/dsh/node_modules/koffi';
  try {
    return existsSync(bundled) ? require_(bundled) : undefined;
  } catch {
    return undefined;
  }
}

// Binary form of S-1-1-0: revision 1, one sub-authority, authority 1, sub-authority 0.
const EVERYONE_BYTES = Buffer.from([1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);

/** Walk an ACL and report whether any ACE names the Everyone SID. */
function aclGrantsEveryoneFullAccess(koffi, aclPtr) {
  const header = Buffer.from(koffi.decode(aclPtr, 'uint8', 8));
  const aceCount = header.readUInt16LE(4);
  const aclSize = header.readUInt16LE(2);
  if (aclSize < 8) return false;
  const acl = Buffer.from(koffi.decode(aclPtr, 'uint8', aclSize));
  let offset = 8;
  for (let i = 0; i < aceCount; i++) {
    if (offset + 4 > acl.length) return false;
    const aceSize = acl.readUInt16LE(offset + 2);
    if (aceSize < 4 || offset + aceSize > acl.length) return false;
    const aceType = acl[offset];
    if ((aceType === 0 || aceType === 1) && aceSize >= 8 + EVERYONE_BYTES.length) {
            const isEveryone = acl.subarray(offset + 8, offset + 8 + EVERYONE_BYTES.length).equals(EVERYONE_BYTES);
      if (isEveryone && aceType === 0) {
        const mask = acl.readUInt32LE(offset + 4);
        if ((mask & FILE_ALL_ACCESS) === FILE_ALL_ACCESS) return true;
      }
    }
    offset += aceSize;
  }
  return false;
}

/** Merge an `Everyone` full-access ACE into this process token's Default DACL. */
function mergeEveryoneIntoDefaultDacl(koffi) {
  const advapi = koffi.load('advapi32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const GetCurrentProcess = kernel32.func('void *GetCurrentProcess()');
  const OpenProcessToken = advapi.func('bool OpenProcessToken(void *h, uint32 acc, void *pToken)');
  const GetTokenInformation = advapi.func('bool GetTokenInformation(void *t, int cls, void *info, uint32 len, void *pRet)');
  const SetTokenInformation = advapi.func('bool SetTokenInformation(void *t, int cls, void *info, uint32 len)');
  const ConvertStringSidToSidW = advapi.func('bool ConvertStringSidToSidW(str16 s, void *pSid)');
  const SetEntriesInAclW = advapi.func('uint32 SetEntriesInAclW(uint32 n, void *entries, void *oldAcl, void *pNewAcl)');
  const CloseHandle = kernel32.func('bool CloseHandle(void *h)');
  const LocalFree = kernel32.func('void *LocalFree(void *p)');

  // EXPLICIT_ACCESS_W layout below is the 64-bit one; on any other architecture the merge is
  // skipped and the console fallback is used instead of risking a wrong grant.
  if (process.arch !== 'x64') return false;

  const tokenSlot = Buffer.alloc(8);
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, tokenSlot)) return false;
  const token = koffi.decode(tokenSlot, 'void *');
  if (!token) return false;

  try {
    const returned = Buffer.alloc(4);
    GetTokenInformation(token, TOKEN_DEFAULT_DACL, null, 0, returned);
    const needed = returned.readUInt32LE(0);
    if (!needed) return false;
    const info = Buffer.alloc(needed);
    if (!GetTokenInformation(token, TOKEN_DEFAULT_DACL, info, needed, returned)) return false;
    const currentDacl = koffi.decode(info, 'void *');
    if (!currentDacl) return false;
    const before = Buffer.from(koffi.decode(currentDacl, 'uint8', 6)).readUInt16LE(4);

    const sidSlot = Buffer.alloc(8);
    if (!ConvertStringSidToSidW(EVERYONE_SID, sidSlot)) return false;
    const sid = koffi.decode(sidSlot, 'void *');
    if (!sid) return false;

    let newAcl;
    try {
      const explicitAccess = Buffer.alloc(EXPLICIT_ACCESS_SIZE);
      explicitAccess.writeUInt32LE(FILE_ALL_ACCESS, 0);
      explicitAccess.writeInt32LE(GRANT_ACCESS, 4);
      explicitAccess.writeInt32LE(TRUSTEE_IS_SID, 28);
      explicitAccess.writeInt32LE(TRUSTEE_IS_WELL_KNOWN_GROUP, 32);
      explicitAccess.writeBigUInt64LE(BigInt(sid), 40);

      const newAclSlot = Buffer.alloc(8);
      if (SetEntriesInAclW(1, explicitAccess, currentDacl, newAclSlot) !== 0) return false;
      newAcl = koffi.decode(newAclSlot, 'void *');
      if (!newAcl) return false;

      const writeBack = Buffer.alloc(8);
      writeBack.writeBigUInt64LE(BigInt(newAcl), 0);
      if (!SetTokenInformation(token, TOKEN_DEFAULT_DACL, writeBack, 8)) return false;
    } finally {
      if (newAcl) LocalFree(newAcl);
      LocalFree(sid);
    }

    // Verify by re-reading the token: the merge must not have lost entries AND the Default DACL
    // must now actually contain an ACE whose SID is Everyone. A silent no-op SetTokenInformation
    // leaves the ACE count unchanged, so a count comparison alone would accept it.
    const again = Buffer.alloc(4);
    GetTokenInformation(token, TOKEN_DEFAULT_DACL, null, 0, again);
    const needed2 = again.readUInt32LE(0);
    if (!needed2) return false;
    const info2 = Buffer.alloc(needed2);
    if (!GetTokenInformation(token, TOKEN_DEFAULT_DACL, info2, needed2, again)) return false;
    const aclPtr = koffi.decode(info2, 'void *');
    if (!aclPtr) return false;
    const after = Buffer.from(koffi.decode(aclPtr, 'uint8', 6)).readUInt16LE(4);
    return after >= before && aclGrantsEveryoneFullAccess(koffi, aclPtr);
  } finally {
    CloseHandle(token);
  }
}

/** Fallback: make sure the runner process owns a console (hidden). */
function ensureRunnerConsole(koffi) {
  const kernel32 = koffi.load('kernel32.dll');
  const user32 = koffi.load('user32.dll');
  const GetConsoleWindow = kernel32.func('void *GetConsoleWindow()');
  const AllocConsole = kernel32.func('int AllocConsole()');
  const GetStdHandle = kernel32.func('void *GetStdHandle(int n)');
  const SetStdHandle = kernel32.func('int SetStdHandle(int n, void *h)');
  const ShowWindow = user32.func('int ShowWindow(void *hWnd, int nCmdShow)');
  if (GetConsoleWindow()) return;
  const saved = [];
  for (const n of STANDARD_HANDLES) {
    try {
      saved.push([n, GetStdHandle(n)]);
    } catch {
      /* keep going: a missing saved handle must not abort the fallback */
    }
  }
  if (AllocConsole() === 0) return;
  for (const [n, handle] of saved) {
    if (!handle) continue;
    try {
      SetStdHandle(n, handle);
    } catch {
      /* best effort: one failed restore must not skip the remaining handles */
    }
  }
  try {
    const created = GetConsoleWindow();
    if (created) ShowWindow(created, SW_HIDE);
  } catch {
    /* the window must never be left visible because hiding failed */
  }
}

try {
  const koffi = loadKoffi();
  const merged = koffi !== undefined && mergeEveryoneIntoDefaultDacl(koffi);
  if (koffi !== undefined && !merged) ensureRunnerConsole(koffi);
  trace('path=' + (merged ? 'default-dacl' : koffi === undefined ? 'no-koffi' : 'console-fallback'));
} catch (error) {
  trace('exception: ' + (error && error.message ? error.message : String(error)));
}



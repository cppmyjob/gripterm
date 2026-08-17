/**
 * The same dump as `env-dump.ps1`, through an interpreter that does not choke.
 *
 * Measured 2026-08-17: inside Cursor both dumps came back as
 * `{"__enumerationFailed":"An item with the same key has already been added."}`.
 * The environment that reaches Cursor's extension host holds two variables whose
 * names differ only in case -- Git Bash contributes `PATH` next to Windows'
 * `Path` -- and PowerShell's `env:` provider builds a case-insensitive
 * dictionary and throws rather than enumerate it. Node's `process.env` merges
 * them instead, so it can answer where PowerShell cannot.
 *
 * The measurement is only comparable within one column: a VS Code column dumped
 * with PowerShell and a Cursor column dumped with Node are each an internally
 * consistent diff of the same thing by the same tool, which is what the question
 * asks; comparing raw key counts ACROSS the two columns is not valid.
 *
 * Usage: node env-dump.js <tag>
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const tag = process.argv[2] ?? 'unknown';
const out = path.join(__dirname, '..', 'results', `env-${tag}.json`);

const map = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) {
    map[key] = value;
  }
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(map), 'utf8');

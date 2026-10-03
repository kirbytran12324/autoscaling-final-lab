#!/usr/bin/env node
'use strict';

const {readdirSync, readFileSync} = require('node:fs');
const {join, relative, resolve} = require('node:path');
const root = resolve(__dirname, '..');
const scopes = ['simulator/src', 'simulator/test', 'simulator/test-support',
  'explorer-api/src', 'explorer-api/test', 'explorer-web/src', 'load-test', 'scripts'];
const sourceExtension = /\.(?:js|cjs|mjs|ts|tsx|css|py|sh)$/;
const excluded = new Set(['node_modules', 'dist', '__pycache__', '.venv', 'vendor', 'generated']);
const large = [], oversized = [];
let count = 0;
function visit(directory) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !excluded.has(entry.name)) visit(path);
    else if (entry.isFile() && sourceExtension.test(entry.name)) {
      const contents = readFileSync(path, 'utf8');
      const lines = contents.split('\n').length - Number(contents.endsWith('\n'));
      count++;
      if (lines > 500) large.push({file: relative(root, path), lines});
      if (lines > 800) oversized.push({file: relative(root, path), lines});
    }
  }
}
for (const scope of scopes) visit(join(root, scope));
for (const item of large) console.log(`${item.lines > 800 ? 'ERROR' : 'Advisory'}: ${item.file}: ${item.lines} lines`);
console.log(`Checked ${count} maintained files; target 200–500 lines, ceiling 800. Small focused modules and facades are allowed.`);
if (oversized.length) process.exitCode = 1;

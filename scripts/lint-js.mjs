import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const roots = ['src', 'scripts', 'tests'];
const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(full);
  }
}

roots.forEach(walk);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    console.error(`Syntax check failed in ${file}:`);
    console.error(err.stderr?.toString() || err.message);
  }
}

if (failed > 0) {
  process.exit(1);
}

console.log(`Lint passed: ${files.length} Vanilla JS ES module files checked with 0 errors.`);

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : [filename];
  });
}
for (const directory of ['local/src', 'remote/src', 'scripts', 'test']) {
  for (const filename of files(path.join(root, directory))) {
    if (filename.endsWith('.js')) execFileSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
    if (filename.endsWith('.py')) {
      execFileSync('python3', ['-I', '-c', 'import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())', filename], { stdio: 'inherit' });
    }
  }
}
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
for (const side of ['local', 'remote']) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, side, 'package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error(`${side} version must match the root package`);
  if (!fs.existsSync(path.join(root, side, manifest.main))) throw new Error(`${side} entry point is missing`);
}
process.stdout.write('Syntax and extension manifest checks passed.\n');

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yazl = require('yazl');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
const digest = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

async function packageRelease() {
  fs.mkdirSync(dist, { recursive: true });
  const packages = [];
  // The workspace component must be built before it can be embedded in the
  // main UI extension. Neither component is downloaded at installation time.
  fs.mkdirSync(path.join(root, 'local', 'assets'), { recursive: true });
  for (const side of ['remote', 'local']) {
    const cwd = path.join(root, side);
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    if (manifest.version !== version) throw new Error('All package versions must match');
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(cwd, 'LICENSE'));
    const destination = side === 'remote'
      ? path.join(root, 'local', 'assets', 'remote.vsix')
      : path.join(dist, `codex-local-bridge-${version}.vsix`);
    // vsce's secret detector can print matched values; never relay its output.
    try {
      execFileSync(process.execPath, [vsce, 'package', '--no-dependencies', '--no-rewrite-relative-links', '--out', destination], { cwd, stdio: 'pipe' });
    } catch {
      throw new Error(`VSIX packaging or its safety checks failed for ${side}; raw tool output suppressed to protect credentials.`);
    }
    process.stdout.write(`Packaged ${path.basename(destination)}.\n`);
    if (side === 'local') packages.push(destination);
  }

  const checksumName = `SHA256SUMS-${version}.txt`;
  const packageChecksums = packages.map(filename => `${digest(filename)}  ${path.basename(filename)}`).join('\n') + '\n';
  const bundle = path.join(dist, `codex-local-bridge-${version}.zip`);
  const prefix = `codex-local-bridge-${version}`;
  const archive = new yazl.ZipFile();
  const completion = new Promise((resolve, reject) => {
    const output = fs.createWriteStream(bundle);
    archive.on('error', reject);
    output.on('error', reject);
    output.on('close', resolve);
    archive.outputStream.pipe(output);
  });
  // Release contents are an explicit allowlist; user settings, logs and caches
  // can never be added by recursively archiving the checkout.
  for (const name of ['README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md', 'CHANGELOG.zh-CN.md', 'SECURITY.md', 'SECURITY.zh-CN.md', 'CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md', 'local/README.md', 'local/README.zh-CN.md', 'remote/README.md', 'remote/README.zh-CN.md']) {
    archive.addFile(path.join(root, name), `${prefix}/${name}`);
  }
  for (const filename of packages) archive.addFile(filename, `${prefix}/dist/${path.basename(filename)}`);
  archive.addBuffer(Buffer.from(packageChecksums), `${prefix}/dist/${checksumName}`);
  archive.end();
  await completion;
  fs.writeFileSync(path.join(dist, checksumName), packageChecksums + `${digest(bundle)}  ${path.basename(bundle)}\n`);
  execFileSync('python3', [path.join(root, 'scripts', 'verify-package.py')], { cwd: root, stdio: 'inherit' });
  process.stdout.write(`Packaged the single installer VSIX, ${path.basename(bundle)} and ${checksumName}.\n`);
}

packageRelease().catch(error => { process.stderr.write(`Packaging failed: ${error.message}\n`); process.exitCode = 1; });

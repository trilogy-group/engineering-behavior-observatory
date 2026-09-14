import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const destination = resolve(process.argv[2] ?? '.ebo/harbor-runtime');
if (!existsSync('dist/src/harbor/worker.js')) throw new Error('Run npm run build first.');
mkdirSync(destination, { recursive: true });
// Build in Linux: host node_modules may contain macOS native SDK dependencies.
const result = spawnSync('docker', ['run', '--rm',
  '--platform', 'linux/arm64',
  '--mount', `type=bind,source=${process.cwd()},target=/source,readonly`,
  '--mount', `type=bind,source=${destination},target=/output`,
  'node:24.19.0-bookworm-slim', 'sh', '-ec', `
    mkdir /runtime
    cp /source/package.json /source/package-lock.json /runtime/
    cd /runtime
    npm ci --omit=dev --no-audit --no-fund
    cp /usr/local/bin/node ./node
    cp -R /source/dist ./dist
    cp -R /source/schemas ./schemas
    cp -R /source/contracts ./contracts
    rm -rf ./dist/test
    ${process.argv.includes('--fixtures') ? 'mkdir -p dist/test; cp /source/dist/test/harbor-provider-worker.js dist/test/' : ''}
    tar czf /output/worker.tgz .
  `], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveDigest = digest(readFileSync(resolve(destination, 'worker.tgz')));
const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const base = flag('--base'), image = flag('--image');
if (base || image) {
  if (!base || !image || !/^\S+@sha256:[a-f0-9]{64}$/.test(base)) throw new Error('Use --base <platform-specific registry digest> --image <local output tag>.');
  const pulled = spawnSync('docker', ['pull', '--platform', 'linux/arm64', base], { stdio: 'inherit' });
  if (pulled.status !== 0) throw new Error('Cannot pull base image');
  const inspected = spawnSync('docker', ['image', 'inspect', base], { encoding: 'utf8' });
  if (inspected.status !== 0) throw new Error('Cannot inspect base image');
  const config = JSON.parse(inspected.stdout)[0].Config;
  const user = config.User || 'root';
  if (/[\r\n]/.test(user)) throw new Error('Invalid base image USER');
  const recipe = `FROM ${base}\nUSER root\nCOPY worker.tgz /tmp/ebo-runtime.tgz\nRUN mkdir -p /opt/ebo && tar -xzf /tmp/ebo-runtime.tgz -C /opt/ebo && rm /tmp/ebo-runtime.tgz && echo ${archiveDigest} > /opt/ebo/runtime.sha256\nUSER ${user}\n`;
  const built = spawnSync('docker', ['build', '--platform', 'linux/arm64', '-t', image, '-f', '-', destination], { input: recipe, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
  if (built.status !== 0) throw new Error('Execution image build failed');
  writeFileSync(resolve(destination, 'image-build.json'), JSON.stringify({ platform: 'linux/arm64', image,
    baseImage: base, baseImageDigest: base.split('@sha256:')[1], recipeDigest: digest(recipe), runtimeArchiveDigest: archiveDigest,
    startup: { user, command: config.Cmd, entrypoint: config.Entrypoint, workdir: config.WorkingDir } }, null, 2));
  console.log('Built locally. Publish explicitly to a registry accessible to Smol, then bind its platform-specific digest in the environment manifest.');
}

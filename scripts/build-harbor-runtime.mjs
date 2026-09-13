import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const destination = resolve(process.argv[2] ?? '.ebo/harbor-runtime');
if (!existsSync('dist/src/harbor/worker.js')) throw new Error('Run npm run build first.');
mkdirSync(destination, { recursive: true });
// Build in Linux: host node_modules may contain macOS native SDK dependencies.
const result = spawnSync('docker', ['run', '--rm',
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
process.exitCode = result.status ?? 1;

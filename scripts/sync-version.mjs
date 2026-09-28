// Keeps src/manifest.json "version" in sync with package.json.
//   node scripts/sync-version.mjs          — write package.json version into manifest
//   node scripts/sync-version.mjs --check  — fail if they differ (and, with
//                                            GITHUB_REF_NAME=vX.Y.Z, if the tag differs)

import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifestPath = 'src/manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (process.argv.includes('--check')) {
  const errors = [];
  if (manifest.version !== pkg.version) {
    errors.push(`manifest.json (${manifest.version}) != package.json (${pkg.version})`);
  }
  const ref = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : '';
  if (ref && ref !== `v${pkg.version}`) {
    errors.push(`tag ${ref} != v${pkg.version}`);
  }
  if (errors.length) {
    console.error(`Version mismatch:\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Version ${pkg.version} OK`);
} else {
  manifest.version = pkg.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest.json version -> ${pkg.version}`);
}

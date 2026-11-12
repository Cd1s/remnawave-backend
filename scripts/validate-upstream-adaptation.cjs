#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const requiredFiles = [
    'src/common/helpers/core-config/core-config.factory.ts',
    'src/common/helpers/core-config/singbox-config.validator.ts',
    'libs/contract/constants/config-profiles/core-type.constant.ts',
    'prisma/migrations/20260716190000_add_config_profile_core_type/migration.sql',
    'scripts/validate-clash-anytls.cjs',
    'scripts/validate-mihomo-anytls.cjs',
    'scripts/validate-singbox-compatibility.cjs',
    'scripts/validate-seed-core-inbounds.cjs',
    'scripts/validate-shadowrocket-anytls.cjs',
];

const requiredPatterns = [
    ['libs/contract/constants/config-profiles/core-type.constant.ts', /SINGBOX/],
    ['src/common/helpers/core-config/core-config.factory.ts', /singbox/],
    ['src/common/helpers/core-config/singbox-config.validator.ts', /listen_port/],
    ['Dockerfile', /FRONTEND_REPO/],
    ['Dockerfile', /__RW_METADATA_GIT_BRANCH/],
];

function gitOutput(args) {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    return result.status === 0 ? result.stdout : '';
}

const failures = [];

for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
        failures.push(`missing required fork file: ${file}`);
    }
}

for (const [file, pattern] of requiredPatterns) {
    if (!fs.existsSync(file) || !pattern.test(fs.readFileSync(file, 'utf8'))) {
        failures.push(`missing fork invariant ${pattern} in ${file}`);
    }
}

const unresolvedFiles = gitOutput(['diff', '--name-only', '--diff-filter=U'])
    .split('\n')
    .filter(Boolean);
if (unresolvedFiles.length > 0) {
    failures.push(`unresolved merge entries: ${unresolvedFiles.join(', ')}`);
}

const markerFiles = gitOutput([
    'grep',
    '-Il',
    '-e',
    '^<<<<<<< ',
    '-e',
    '^=======',
    '-e',
    '^>>>>>>> ',
    '--',
    '.',
])
    .split('\n')
    .filter(Boolean);
if (markerFiles.length > 0) {
    failures.push(`merge conflict markers remain in: ${markerFiles.join(', ')}`);
}

if (failures.length > 0) {
    console.error('fork_adaptation_preflight=failed');
    for (const failure of failures) {
        console.error(`- ${failure}`);
    }
    process.exitCode = 1;
} else {
    console.log('fork_adaptation_preflight=passed');
}

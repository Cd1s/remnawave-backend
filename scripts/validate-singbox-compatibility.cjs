#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

require('./register-typescript.cjs');

const {
    DEFAULT_TEMPLATE_SINGBOX,
} = require('../src/modules/subscription-template/constants/default-templates.ts');
const {
    SingBoxGeneratorService,
} = require('../src/modules/subscription-template/generators/singbox.generator.service.ts');

function createFixture() {
    const config = JSON.parse(JSON.stringify(DEFAULT_TEMPLATE_SINGBOX));
    const anyTls = {
        type: 'anytls',
        tag: 'anytls-test',
        server: 'example.com',
        server_port: 443,
        password: 'test-password',
        tls: {
            enabled: true,
            server_name: 'example.com',
        },
    };

    config.outbounds.push(anyTls);
    config.outbounds[0].outbounds = ['direct', anyTls.tag];
    return config;
}

function assertAnyTlsOutbound(config) {
    const anyTls = config.outbounds.find((outbound) => outbound.type === 'anytls');
    assert.ok(anyTls, 'the compatibility fixture must retain an AnyTLS outbound');
    assert.equal(anyTls.tag, 'anytls-test');
    assert.equal(anyTls.server, 'example.com');
    assert.equal(anyTls.server_port, 443);
    assert.equal(anyTls.password, 'test-password');
    assert.deepEqual(anyTls.tls, {
        enabled: true,
        server_name: 'example.com',
    });
}

function assertMigratedTemplate(config) {
    assert.equal(config.dns.fakeip, undefined);
    assert.equal(config.dns.independent_cache, undefined);
    assert.ok(config.dns.servers.every((server) => server.type && !server.address));
    assert.deepEqual(config.route.default_domain_resolver, {
        server: 'local',
        strategy: 'ipv4_only',
    });
    assert.ok(config.route.rules.some((rule) => rule.action === 'sniff'));
    assert.ok(config.inbounds.every((inbound) => inbound.sniff === undefined));
    assert.deepEqual(config.inbounds[0].address, ['172.19.0.1/30', 'fdfe:dcba:9876::1/126']);
}

async function assertGeneratedAnyTlsOutbound() {
    const template = createFixture();
    template.outbounds = template.outbounds.filter((outbound) => outbound.type !== 'anytls');
    const service = new SingBoxGeneratorService({
        getCachedTemplateByType: async () => template,
    });
    const generated = JSON.parse(
        await service.generateConfig([
            {
                finalRemark: 'anytls-test',
                address: 'example.com',
                port: 443,
                protocol: 'anytls',
                protocolOptions: { password: 'test-password' },
                security: 'tls',
                securityOptions: { serverName: 'example.com', fingerprint: null },
                transport: 'tcp',
                transportOptions: {},
                clientOverrides: {
                    shuffleHost: false,
                    mihomoX25519: false,
                    mihomoIpVersion: null,
                    serverDescription: null,
                    xrayJsonTemplate: null,
                    mapper: {},
                },
                metadata: { excludeFromSubscriptionTypes: [] },
            },
        ]),
    );
    const anyTls = generated.outbounds.find((outbound) => outbound.type === 'anytls');
    assert.deepEqual(anyTls.domain_resolver, { server: 'local' });
}

function resolveBinary() {
    const configured = process.env.SINGBOX_BIN || 'sing-box';
    if (fs.existsSync(configured)) return configured;

    const lookup = spawnSync('sh', ['-c', `command -v ${configured}`], { encoding: 'utf8' });
    if (lookup.status === 0 && lookup.stdout.trim()) return lookup.stdout.trim();

    throw new Error(
        `official sing-box binary not found; set SINGBOX_BIN or install ${configured} before running the config check`,
    );
}

function runCheck(binary, configPath) {
    const result = spawnSync(binary, ['check', '-c', configPath], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    });

    const details = `${result.stderr || ''}${result.stdout || ''}`.trim();
    if (result.status !== 0) {
        throw new Error(
            `sing-box rejected the default template (exit=${result.status}): ${details}`,
        );
    }

    // Deprecated fields become fatal in the next sing-box minor release unless clients opt in.
    if (/deprecated/i.test(details)) {
        throw new Error(`sing-box reported deprecated fields in the default template: ${details}`);
    }
}

async function main() {
    const config = createFixture();
    assertAnyTlsOutbound(config);
    assertMigratedTemplate(config);
    await assertGeneratedAnyTlsOutbound();

    if (process.argv.includes('--skip-binary')) {
        process.stdout.write('singbox_binary_check=skipped\n');
        process.stdout.write('singbox_anytls_outbound_valid=true\n');
        return;
    }

    const binary = resolveBinary();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remnawave-singbox-'));
    const configPath = path.join(tempDir, 'config.json');
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    runCheck(binary, configPath);
    process.stdout.write(`singbox_binary_check=passed binary=${binary}\n`);
    process.stdout.write('singbox_anytls_outbound_valid=true\n');
}

try {
    main();
} catch (error) {
    console.error(`singbox_validation=failed reason=${error.message}`);
    process.exitCode = 1;
}

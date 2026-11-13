#!/usr/bin/env node
'use strict';

/**
 * Validates every Remnawave-managed sing-box inbound type end to end:
 *
 * 1. Remnawave user injection produces a server config that the official sing-box binary accepts.
 * 2. Subscription resolution produces sing-box, Mihomo and share-link client output whose
 *    credentials match the injected server users.
 * 3. Real HTTP traffic passes through every inbound with the generated sing-box outbounds and with
 *    the generated Mihomo proxies.
 *
 * `--skip-binary` runs only the in-process consistency checks.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { dump, load } = require('js-yaml');

require('./register-typescript.cjs');

const { SingBoxConfig } = require('../src/common/helpers/core-config/singbox-config.validator.ts');
const {
    ResolveProxyConfigService,
} = require('../src/modules/subscription-template/resolve-proxy/resolve-proxy-config.service.ts');
const {
    SingBoxGeneratorService,
} = require('../src/modules/subscription-template/generators/singbox.generator.service.ts');
const {
    MihomoGeneratorService,
} = require('../src/modules/subscription-template/generators/mihomo.generator.service.ts');
const {
    XrayGeneratorService,
} = require('../src/modules/subscription-template/generators/xray.generator.service.ts');
const {
    DEFAULT_TEMPLATE_SINGBOX,
} = require('../src/modules/subscription-template/constants/default-templates.ts');

const skipBinary = process.argv.includes('--skip-binary');
const SERVER_NAME = 'example.com';
const LOOPBACK = '127.0.0.1';
const BASE_PORT = 21_000;

function resolveBinary(envName, fallback) {
    const configured = process.env[envName] || fallback;
    if (fs.existsSync(configured)) return configured;

    const lookup = spawnSync('sh', ['-c', `command -v ${configured}`], { encoding: 'utf8' });
    if (lookup.status === 0 && lookup.stdout.trim()) return lookup.stdout.trim();

    throw new Error(`${fallback} binary not found; set ${envName} or use --skip-binary`);
}

function run(binary, args) {
    const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) {
        throw new Error(
            `${path.basename(binary)} ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`,
        );
    }
    return result.stdout;
}

function createTlsKeyPair(singBox) {
    if (!singBox) {
        return { certificate: ['test-certificate'], key: ['test-key'] };
    }

    const output = run(singBox, ['generate', 'tls-keypair', SERVER_NAME]);
    const pemBlock = (label) => {
        const match = new RegExp(`-----BEGIN ${label}-----[\\s\\S]+?-----END ${label}-----`).exec(
            output,
        );
        assert.ok(match, `sing-box did not generate a ${label}`);
        return match[0].split('\n').filter(Boolean);
    };

    return { certificate: pemBlock('CERTIFICATE'), key: pemBlock('PRIVATE KEY') };
}

function createRealityKeyPair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    return {
        privateKey: privateKey.export({ format: 'jwk' }).d,
        publicKey: publicKey.export({ format: 'jwk' }).x,
    };
}

function createProfile(tlsKeyPair, reality, ss2022ServerKey) {
    const tls = {
        enabled: true,
        server_name: SERVER_NAME,
        certificate: tlsKeyPair.certificate,
        key: tlsKeyPair.key,
    };
    const listen = (index) => ({ listen: LOOPBACK, listen_port: BASE_PORT + index });

    const inbounds = [
        { type: 'trojan', tag: 'trojan-tls', ...listen(0), users: [], tls },
        {
            type: 'vless',
            tag: 'vless-reality-vision',
            ...listen(1),
            users: [],
            tls: {
                enabled: true,
                server_name: SERVER_NAME,
                reality: {
                    enabled: true,
                    handshake: { server: LOOPBACK, server_port: BASE_PORT },
                    private_key: reality.privateKey,
                    short_id: ['0123456789abcdef'],
                },
            },
        },
        { type: 'vless', tag: 'vless-tls-vision', ...listen(2), users: [], tls },
        {
            type: 'vless',
            tag: 'vless-ws-tls',
            ...listen(3),
            users: [],
            tls,
            transport: { type: 'ws', path: '/vless-ws' },
        },
        {
            type: 'vless',
            tag: 'vless-grpc-tls',
            ...listen(4),
            users: [],
            tls,
            transport: { type: 'grpc', service_name: 'vless-grpc' },
        },
        {
            type: 'vless',
            tag: 'vless-httpupgrade',
            ...listen(5),
            users: [],
            transport: { type: 'httpupgrade', path: '/vless-hu' },
        },
        {
            type: 'trojan',
            tag: 'trojan-ws-tls-early-data',
            ...listen(6),
            users: [],
            tls,
            transport: {
                type: 'ws',
                path: '/trojan-ws',
                max_early_data: 2048,
                early_data_header_name: 'Sec-WebSocket-Protocol',
            },
        },
        {
            type: 'shadowsocks',
            tag: 'ss2022-aes',
            ...listen(7),
            method: '2022-blake3-aes-256-gcm',
            password: ss2022ServerKey,
            users: [],
        },
        {
            type: 'hysteria2',
            tag: 'hysteria2-gecko',
            ...listen(8),
            users: [],
            obfs: {
                type: 'gecko',
                password: 'gecko-password',
                min_packet_size: 600,
                max_packet_size: 1100,
            },
            tls,
        },
        {
            type: 'shadowsocks',
            tag: 'ss-aead',
            ...listen(9),
            method: 'aes-256-gcm',
            users: [],
        },
        {
            type: 'hysteria2',
            tag: 'hysteria2-salamander',
            ...listen(10),
            users: [],
            obfs: { type: 'salamander', password: 'obfs-password' },
            tls,
        },
        {
            type: 'tuic',
            tag: 'tuic-bbr',
            ...listen(11),
            users: [],
            congestion_control: 'bbr',
            tls: { ...tls, alpn: ['h3'] },
        },
        { type: 'anytls', tag: 'anytls', ...listen(12), users: [], tls },
        {
            type: 'mixed',
            tag: 'unmanaged-mixed',
            listen: LOOPBACK,
            listen_port: BASE_PORT + 99,
            users: [{ username: 'admin', password: 'kept' }],
        },
    ];

    return {
        log: { level: 'warn' },
        inbounds,
        outbounds: [{ type: 'direct', tag: 'direct' }],
        route: { final: 'direct' },
    };
}

function createUsers(tags) {
    const user = (id, ssPassword) => ({
        id: BigInt(id),
        vlessUuid: crypto.randomUUID(),
        trojanPassword: crypto.randomBytes(16).toString('hex'),
        ssPassword,
        tags,
    });

    return [
        user(1, 'abcdefghijklmnopqrstuvwxyz012345'),
        user(2, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'),
        // A custom 12-character password cannot form a 32-byte SS2022 key.
        user(3, 'short-secret'),
    ];
}

function assertRejectedProfiles(tlsKeyPair, reality, ss2022ServerKey) {
    const withInbound = (tag, change) => {
        const config = createProfile(tlsKeyPair, reality, ss2022ServerKey);
        Object.assign(
            config.inbounds.find((inbound) => inbound.tag === tag),
            change,
        );
        return config;
    };
    const rejected = [
        [
            'SS2022 without multi-user support',
            withInbound('ss2022-aes', { method: '2022-blake3-chacha20-poly1305' }),
        ],
        [
            'SS2022 with 16-byte user keys',
            withInbound('ss2022-aes', { method: '2022-blake3-aes-128-gcm' }),
        ],
        ['SS2022 without a server key', withInbound('ss2022-aes', { password: 'not-a-key' })],
        ['Shadowsocks without encryption', withInbound('ss-aead', { method: 'none' })],
        ['Hysteria2 without TLS', withInbound('hysteria2-salamander', { tls: undefined })],
        ['TUIC without TLS', withInbound('tuic-bbr', { tls: { enabled: false } })],
    ];

    for (const [label, config] of rejected) {
        assert.throws(() => new SingBoxConfig(config), Error, `${label} must be rejected`);
    }
}

function assertServerUsers(serverConfig, users, ss2022ServerKey) {
    const byTag = new Map(serverConfig.inbounds.map((inbound) => [inbound.tag, inbound]));
    const names = (tag) => byTag.get(tag).users.map((user) => user.name);
    const [first] = users;

    assert.deepEqual(
        names('ss2022-aes'),
        ['1', '2'],
        'SS2022 must skip users without a 32-byte key',
    );
    assert.equal(
        byTag.get('ss2022-aes').users[0].password,
        Buffer.from(first.ssPassword).toString('base64'),
    );
    assert.equal(byTag.get('ss2022-aes').password, ss2022ServerKey);
    assert.deepEqual(names('ss-aead'), ['1', '2', '3']);
    assert.equal(byTag.get('ss-aead').users[0].password, first.ssPassword);

    assert.deepEqual(byTag.get('vless-reality-vision').users[0], {
        name: '1',
        uuid: first.vlessUuid,
        flow: 'xtls-rprx-vision',
    });
    assert.equal(byTag.get('vless-tls-vision').users[0].flow, 'xtls-rprx-vision');
    for (const tag of ['vless-ws-tls', 'vless-grpc-tls', 'vless-httpupgrade']) {
        assert.equal(byTag.get(tag).users[0].flow, undefined, `${tag} must not use Vision`);
    }

    assert.deepEqual(byTag.get('hysteria2-salamander').users[0], {
        name: '1',
        password: first.vlessUuid,
    });
    assert.deepEqual(byTag.get('tuic-bbr').users[0], {
        name: '1',
        uuid: first.vlessUuid,
        password: first.vlessUuid,
    });
    assert.deepEqual(byTag.get('trojan-tls').users[0], {
        name: '1',
        password: first.trojanPassword,
    });
    assert.deepEqual(byTag.get('unmanaged-mixed').users, [{ username: 'admin', password: 'kept' }]);
}

function createHost(inbound, index) {
    return {
        uuid: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
        remark: inbound.tag,
        address: LOOPBACK,
        port: inbound.listen_port,
        path: null,
        sni: null,
        host: null,
        alpn: null,
        fingerprint: null,
        isDisabled: false,
        isHidden: false,
        securityLayer: 'DEFAULT',
        xHttpExtraParams: null,
        muxParams: null,
        sockoptParams: null,
        finalMask: null,
        serverDescription: null,
        tags: [],
        includeInSrrRules: [],
        excludeFromSubscriptionTypes: [],
        overrideSniFromAddress: false,
        keepSniBlank: false,
        // Xray-only; sing-box must ignore it or authentication fails.
        vlessRouteId: 4660,
        shuffleHost: false,
        mihomoX25519: false,
        mihomoIpVersion: null,
        // Remnawave maps a certificate pin to "skip verification" in these generators.
        pinnedPeerCertSha256: 'self-signed',
        verifyPeerCertByName: null,
        mapper: {},
        xrayJsonTemplate: null,
        configProfileUuid: '00000000-0000-0000-0000-0000000000aa',
        configProfileInboundUuid: `00000000-0000-0000-0000-${String(index + 100).padStart(12, '0')}`,
        viewPosition: index,
        inboundTag: inbound.tag,
        rawInbound: inbound,
    };
}

async function resolveClientConfigs(profileInbounds, user, reality) {
    const resolver = new ResolveProxyConfigService({ getOrThrow: () => 'sub.example.com' });
    const hosts = profileInbounds.map(createHost);
    const resolved = await resolver.resolveProxyConfig({
        subscriptionSettings: { isShowCustomRemarks: false, customRemarks: {} },
        hosts,
        user: {
            ...user,
            username: 'validator',
            status: 'ACTIVE',
            shortUuid: 'validator',
        },
    });

    assert.deepEqual(
        resolved.map((host) => host.finalRemark),
        profileInbounds.map((inbound) => inbound.tag),
        'every managed inbound must resolve to a subscription host',
    );

    const byRemark = new Map(resolved.map((host) => [host.finalRemark, host]));
    const realityHost = byRemark.get('vless-reality-vision');
    assert.equal(realityHost.security, 'reality');
    assert.equal(realityHost.securityOptions.publicKey, reality.publicKey);
    assert.equal(realityHost.securityOptions.shortId, '0123456789abcdef');
    assert.equal(realityHost.protocolOptions.id, user.vlessUuid);
    assert.equal(
        byRemark.get('trojan-ws-tls-early-data').transportOptions.path,
        '/trojan-ws?ed=2048',
    );
    assert.equal(byRemark.get('tuic-bbr').protocol, 'tuic');
    assert.equal(byRemark.get('hysteria2-salamander').transportOptions.auth, user.vlessUuid);

    return resolved;
}

async function generateClientConfigs(resolved) {
    const singBoxTemplate = JSON.parse(JSON.stringify(DEFAULT_TEMPLATE_SINGBOX));
    const singBoxGenerator = new SingBoxGeneratorService({
        getCachedTemplateByType: async () => singBoxTemplate,
    });
    const singBoxSubscription = JSON.parse(await singBoxGenerator.generateConfig(resolved));
    const singBoxOutbounds = singBoxSubscription.outbounds.filter((outbound) =>
        resolved.some((host) => host.finalRemark === outbound.tag),
    );
    assert.equal(
        singBoxOutbounds.length,
        resolved.length,
        'sing-box output must include every host',
    );

    const mihomoGenerator = new MihomoGeneratorService({
        getCachedTemplateByType: async () => ({
            proxies: [],
            'proxy-groups': [{ name: '→ Remnawave', type: 'select', proxies: [] }],
            rules: ['MATCH,→ Remnawave'],
        }),
    });
    const mihomoYaml = await mihomoGenerator.generateConfig(resolved);
    const mihomoProxies = load(mihomoYaml).proxies;
    assert.equal(mihomoProxies.length, resolved.length, 'Mihomo output must include every host');

    const stashProxies = load(await mihomoGenerator.generateConfig(resolved, true)).proxies;
    const stashTuic = stashProxies.find((proxy) => proxy.type === 'tuic');
    assert.equal(stashTuic.version, 5, 'Stash requires an explicit TUIC version');

    const links = new XrayGeneratorService().generateLinks(resolved, false);
    assert.equal(links.length, resolved.length, 'share links must include every host');
    const tuicLink = new URL(links.find((link) => link.startsWith('tuic://')));
    const tuicHost = resolved.find((host) => host.protocol === 'tuic');
    assert.equal(decodeURIComponent(tuicLink.username), tuicHost.protocolOptions.uuid);
    assert.equal(decodeURIComponent(tuicLink.password), tuicHost.protocolOptions.password);
    assert.equal(tuicLink.searchParams.get('congestion_control'), 'bbr');

    return { singBoxSubscription, singBoxOutbounds, mihomoYaml, mihomoProxies };
}

function writeTemp(directory, name, content) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, content);
    return file;
}

function waitForPort(port, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const socket = net.connect(port, LOOPBACK);
            socket.once('connect', () => {
                socket.destroy();
                resolve();
            });
            socket.once('error', () => {
                socket.destroy();
                if (Date.now() > deadline) {
                    reject(new Error(`port ${port} did not open`));
                } else {
                    setTimeout(attempt, 100);
                }
            });
        };
        attempt();
    });
}

function startProcess(binary, args, label) {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('exit', (code) => {
        if (code !== null && code !== 0) output += `\n${label} exited with ${code}`;
    });
    return { child, output: () => output };
}

function fetchThroughProxy(proxyPort, originPort, pathname) {
    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                host: LOOPBACK,
                port: proxyPort,
                method: 'GET',
                path: `http://${LOOPBACK}:${originPort}${pathname}`,
                headers: { Host: `${LOOPBACK}:${originPort}` },
                timeout: 15_000,
            },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () =>
                    resolve({ status: response.statusCode, body: Buffer.concat(chunks) }),
                );
            },
        );
        request.on('timeout', () => request.destroy(new Error('request timed out')));
        request.on('error', reject);
        request.end();
    });
}

function countUserConnections(serverOutput, tag) {
    // sing-box logs `inbound/<type>[<tag>]: [<user name>] inbound connection ...` once the user
    // authenticated; v2ray_api user traffic statistics use the same user name.
    return serverOutput.split(`[${tag}]: [1] inbound `).length - 1;
}

async function assertTransfers(label, proxyPortByTag, originPort, payload, server, client) {
    for (const [tag, proxyPort] of proxyPortByTag) {
        const connectionsBefore = countUserConnections(server.output(), tag);
        let response;
        try {
            response = await fetchThroughProxy(proxyPort, originPort, `/${tag}`);
        } catch (error) {
            throw new Error(
                `${label} ${tag}: ${error.message}\n${server.output()}\n${client.output()}`,
            );
        }
        assert.equal(response.status, 200, `${label} ${tag} returned HTTP ${response.status}`);
        assert.ok(response.body.equals(payload), `${label} ${tag} returned a corrupted body`);
        assert.ok(
            countUserConnections(server.output(), tag) > connectionsBefore,
            `${label} ${tag} was not attributed to user 1 by the server`,
        );
        process.stdout.write(`${label}_transfer_${tag}=passed\n`);
    }
}

async function runTransfers(binaries, directory, serverConfig, clients) {
    const payload = crypto.randomBytes(256 * 1024);
    const origin = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Length': payload.length });
        response.end(payload);
    });
    const originPort = BASE_PORT + 900;
    await new Promise((resolve) => origin.listen(originPort, LOOPBACK, resolve));

    const processes = [];
    try {
        const serverPath = writeTemp(
            directory,
            'server.json',
            JSON.stringify({ ...serverConfig, log: { level: 'info' } }),
        );
        const server = startProcess(binaries.singBox, ['run', '-c', serverPath], 'sing-box server');
        processes.push(server.child);
        await waitForPort(BASE_PORT);

        const singBoxPorts = new Map(
            clients.singBoxOutbounds.map((outbound, index) => [
                outbound.tag,
                BASE_PORT + 200 + index,
            ]),
        );
        const singBoxClient = {
            log: { level: 'warn' },
            inbounds: [...singBoxPorts].map(([tag, port]) => ({
                type: 'mixed',
                tag: `in-${tag}`,
                listen: LOOPBACK,
                listen_port: port,
            })),
            // No direct outbound: a request that bypasses the generated outbound fails.
            outbounds: clients.singBoxOutbounds.map(
                ({ domain_resolver: _resolver, ...outbound }) => outbound,
            ),
            route: {
                rules: [
                    ...[...singBoxPorts.keys()].map((tag) => ({
                        inbound: [`in-${tag}`],
                        action: 'route',
                        outbound: tag,
                    })),
                    { action: 'reject' },
                ],
            },
        };
        const singBoxClientPath = writeTemp(
            directory,
            'client.json',
            JSON.stringify(singBoxClient),
        );
        const client = startProcess(
            binaries.singBox,
            ['run', '-c', singBoxClientPath],
            'sing-box client',
        );
        processes.push(client.child);
        await Promise.all([...singBoxPorts.values()].map((port) => waitForPort(port)));
        await assertTransfers('singbox', singBoxPorts, originPort, payload, server, client);

        const mihomoPorts = new Map(
            clients.mihomoProxies.map((proxy, index) => [proxy.name, BASE_PORT + 400 + index]),
        );
        const mihomoDirectory = path.join(directory, 'mihomo');
        fs.mkdirSync(mihomoDirectory);
        const mihomoConfig = {
            'log-level': 'warning',
            ipv6: false,
            mode: 'rule',
            proxies: clients.mihomoProxies,
            listeners: [...mihomoPorts].map(([name, port]) => ({
                name: `in-${name}`,
                type: 'mixed',
                listen: LOOPBACK,
                port,
                proxy: name,
            })),
            rules: ['MATCH,REJECT'],
        };
        const mihomoPath = writeTemp(mihomoDirectory, 'config.yaml', dump(mihomoConfig));
        const mihomo = startProcess(
            binaries.mihomo,
            ['-d', mihomoDirectory, '-f', mihomoPath],
            'mihomo',
        );
        processes.push(mihomo.child);
        await Promise.all([...mihomoPorts.values()].map((port) => waitForPort(port)));
        await assertTransfers('mihomo', mihomoPorts, originPort, payload, server, mihomo);
    } finally {
        for (const child of processes) child.kill('SIGKILL');
        origin.close();
    }
}

async function main() {
    const binaries = skipBinary
        ? null
        : {
              singBox: resolveBinary('SINGBOX_BIN', 'sing-box'),
              mihomo: resolveBinary('MIHOMO_BIN', 'mihomo'),
          };

    const tlsKeyPair = createTlsKeyPair(binaries?.singBox);
    const reality = createRealityKeyPair();
    const ss2022ServerKey = crypto.randomBytes(32).toString('base64');

    assertRejectedProfiles(tlsKeyPair, reality, ss2022ServerKey);

    const profile = new SingBoxConfig(createProfile(tlsKeyPair, reality, ss2022ServerKey));
    profile.cleanInboundClients(false);
    const profileInbounds = profile.getAllInbounds().map((inbound) => inbound.rawInbound);
    assert.equal(profileInbounds.length, 13, 'every managed inbound type must be recognized');
    const storedProfileInbounds = JSON.parse(JSON.stringify(profileInbounds));

    const users = createUsers(profileInbounds.map((inbound) => inbound.tag));
    const userSets = new Map();
    const serverConfig = profile.includeUserBatch(users, userSets);
    assertServerUsers(serverConfig, users, ss2022ServerKey);
    assert.equal(
        userSets.get('ss2022-aes').size,
        2,
        'skipped users must not count toward the hash',
    );

    const resolved = await resolveClientConfigs(storedProfileInbounds, users[0], reality);
    const clients = await generateClientConfigs(resolved);
    process.stdout.write('singbox_inbounds_consistency=passed\n');

    if (!binaries) {
        process.stdout.write('singbox_inbounds_binary_check=skipped\n');
        return;
    }

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remnawave-singbox-inbounds-'));
    try {
        run(binaries.singBox, [
            'check',
            '-c',
            writeTemp(directory, 'check-server.json', JSON.stringify(serverConfig)),
        ]);
        run(binaries.singBox, [
            'check',
            '-c',
            writeTemp(
                directory,
                'check-subscription.json',
                JSON.stringify(clients.singBoxSubscription),
            ),
        ]);
        run(binaries.mihomo, [
            '-t',
            '-f',
            writeTemp(directory, 'check-mihomo.yaml', clients.mihomoYaml),
        ]);
        process.stdout.write('singbox_inbounds_binary_check=passed\n');

        await runTransfers(binaries, directory, serverConfig, clients);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }

    process.stdout.write('singbox_inbounds_validation=passed\n');
}

main().catch((error) => {
    console.error(`singbox_inbounds_validation=failed reason=${error.stack || error.message}`);
    process.exitCode = 1;
});

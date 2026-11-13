import { hasher } from 'node-object-hash';
import { readFileSync } from 'node:fs';

import { HashedSet } from '@remnawave/hashed-set';

import { UserForConfigEntity } from '@modules/users/entities/users-for-config';

import { ICoreConfig, ICoreConfigInbound } from './core-config.interface';
import {
    getSingBoxSsSupportedMethods,
    getSingBoxSsUserPassword,
    getSingBoxVlessFlow,
    isSingBoxManagedInbound,
    isSingBoxRealityEnabled,
    isSingBoxSs2022Key,
    isSingBoxSs2022Method,
    isSingBoxSsMethodSupported,
    isSingBoxTlsRequired,
} from './singbox-inbound';

type TJsonRecord = Record<string, unknown>;

interface ISingBoxInbound extends TJsonRecord {
    type: string;
    tag: string;
    listen_port?: number;
    network?: string | string[];
    transport?: {
        type?: string;
    };
    tls?: {
        enabled?: boolean;
        certificate?: string | string[];
        certificate_path?: string;
        key?: string | string[];
        key_path?: string;
        reality?: {
            enabled?: boolean;
        };
    };
    multiplex?: {
        enabled?: boolean;
    };
    method?: string;
    password?: string;
    users?: TJsonRecord[];
}

interface ISingBoxConfig extends TJsonRecord {
    inbounds: ISingBoxInbound[];
    outbounds?: TJsonRecord[];
    route?: {
        rules?: TJsonRecord[];
        rule_set?: TJsonRecord[];
    };
}

type TCtrSingBoxConfig = object | Record<string, unknown> | string;

export class SingBoxConfig implements ICoreConfig {
    private config: ISingBoxConfig;
    private inboundsByTag = new Map<string, ISingBoxInbound>();

    constructor(configInput: TCtrSingBoxConfig) {
        this.config = this.parseConfig(configInput);
        this.validate();
        this.indexInbounds();
    }

    public getConfig(): ISingBoxConfig {
        return this.config;
    }

    public getSortedConfig(): ISingBoxConfig {
        return this.sortObject(this.config) as ISingBoxConfig;
    }

    public getConfigHash(): string {
        const hash = hasher({ trim: true, sort: false }).hash;
        return hash(this.getSortedConfig());
    }

    public getAllInbounds(): ICoreConfigInbound[] {
        return this.config.inbounds
            .filter((inbound) => isSingBoxManagedInbound(inbound))
            .map((inbound) => ({
                tag: inbound.tag,
                rawInbound: inbound,
                type: inbound.type,
                network: this.getNetwork(inbound),
                security: this.getSecurity(inbound),
                port: this.parsePort(inbound.listen_port),
            }));
    }

    public cleanInboundClients(): void {
        for (const inbound of this.config.inbounds) {
            if (!isSingBoxManagedInbound(inbound)) continue;
            inbound.users = [];
        }
    }

    public processCertificates(): ISingBoxConfig {
        for (const inbound of this.config.inbounds) {
            if (!inbound.tls) continue;

            if (inbound.tls.certificate_path) {
                try {
                    inbound.tls.certificate = this.readPemLines(inbound.tls.certificate_path);
                    delete inbound.tls.certificate_path;
                } catch {
                    // The path may intentionally only exist inside the node container.
                }
            }

            if (inbound.tls.key_path) {
                try {
                    inbound.tls.key = this.readPemLines(inbound.tls.key_path);
                    delete inbound.tls.key_path;
                } catch {
                    // The path may intentionally only exist inside the node container.
                }
            }
        }

        return this.config;
    }

    public replaceSnippets(snippets: Map<string, unknown>): void {
        this.replaceSnippetsInArray(this.config.outbounds, snippets);
        this.replaceSnippetsInArray(this.config.route?.rules, snippets);
        this.replaceSnippetsInArray(this.config.route?.rule_set, snippets);
    }

    public leaveInbounds(tags: Set<string>): void {
        this.config.inbounds = this.config.inbounds.filter(
            (inbound) => tags.has(inbound.tag) || !isSingBoxManagedInbound(inbound),
        );
        this.indexInbounds();
    }

    public includeUserBatch(
        users: UserForConfigEntity[],
        inboundsUserSets: Map<string, HashedSet>,
    ): ISingBoxConfig {
        for (const user of users) {
            for (const tag of user.tags) {
                const inbound = this.inboundsByTag.get(tag);
                if (!inbound || !isSingBoxManagedInbound(inbound)) continue;

                const singBoxUser = this.toSingBoxUser(inbound, user);
                if (!singBoxUser) continue;

                inbound.users ??= [];
                inbound.users.push(singBoxUser);

                if (!inboundsUserSets.has(tag)) {
                    inboundsUserSets.set(tag, new HashedSet());
                }
                inboundsUserSets.get(tag)!.add(user.vlessUuid);
            }
        }

        return this.config;
    }

    public fixIncorrectServerNames(): void {
        // sing-box uses a single tls.server_name value and needs no Xray-specific cleanup.
    }

    private toSingBoxUser(inbound: ISingBoxInbound, user: UserForConfigEntity): TJsonRecord | null {
        const name = user.id.toString();

        switch (inbound.type) {
            case 'anytls':
            case 'hysteria2':
                return {
                    name,
                    password: user.vlessUuid,
                };
            case 'vless': {
                const flow = getSingBoxVlessFlow(inbound);
                return {
                    name,
                    uuid: user.vlessUuid,
                    ...(flow && { flow }),
                };
            }
            case 'tuic':
                return {
                    name,
                    uuid: user.vlessUuid,
                    password: user.vlessUuid,
                };
            case 'trojan':
                return {
                    name,
                    password: user.trojanPassword,
                };
            case 'shadowsocks': {
                const password = getSingBoxSsUserPassword(inbound, user.ssPassword);
                return password === null ? null : { name, password };
            }
            default:
                throw new Error(`Protocol ${inbound.type} is not supported.`);
        }
    }

    private parseConfig(configInput: TCtrSingBoxConfig): ISingBoxConfig {
        let parsed: unknown = configInput;

        if (typeof configInput === 'string') {
            try {
                parsed = JSON.parse(configInput);
            } catch (error) {
                throw new Error(`Invalid JSON input: ${error}`);
            }
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Invalid sing-box configuration format.');
        }

        return parsed as ISingBoxConfig;
    }

    private validate(): void {
        if (!Array.isArray(this.config.inbounds) || this.config.inbounds.length === 0) {
            throw new Error("Config doesn't have inbounds.");
        }

        const seenTags = new Set<string>();

        for (const inbound of this.config.inbounds) {
            if (!inbound || typeof inbound !== 'object') {
                throw new Error('Every sing-box inbound must be an object.');
            }
            if (typeof inbound.type !== 'string' || inbound.type.length === 0) {
                throw new Error('Every sing-box inbound must have a type.');
            }
            if (typeof inbound.tag !== 'string' || inbound.tag.length === 0) {
                throw new Error('Every sing-box inbound must have a unique tag.');
            }
            if (inbound.tag.includes(',')) {
                throw new Error("Character ',' is not allowed in inbound tag.");
            }
            if (seenTags.has(inbound.tag)) {
                throw new Error(`Duplicate inbound tag "${inbound.tag}" found.`);
            }
            if (
                inbound.listen_port !== undefined &&
                (!Number.isInteger(inbound.listen_port) ||
                    inbound.listen_port < 1 ||
                    inbound.listen_port > 65_535)
            ) {
                throw new Error(`Invalid listen_port in inbound "${inbound.tag}".`);
            }
            this.validateManagedInbound(inbound);
            seenTags.add(inbound.tag);
        }
    }

    private validateManagedInbound(inbound: ISingBoxInbound): void {
        if (!isSingBoxManagedInbound(inbound)) return;

        if (isSingBoxTlsRequired(inbound.type) && !inbound.tls?.enabled) {
            throw new Error(`${inbound.type} inbound "${inbound.tag}" requires tls.enabled.`);
        }

        if (inbound.type !== 'shadowsocks') return;

        if (!isSingBoxSsMethodSupported(inbound.method)) {
            throw new Error(
                `Shadowsocks inbound "${inbound.tag}" uses unsupported method "${inbound.method}". ` +
                    `Supported methods: ${getSingBoxSsSupportedMethods().join(', ')}.`,
            );
        }

        if (isSingBoxSs2022Method(inbound.method) && !isSingBoxSs2022Key(inbound.password)) {
            throw new Error(
                `Shadowsocks inbound "${inbound.tag}" requires a base64 32-byte server key in "password" ` +
                    '(sing-box generate rand --base64 32).',
            );
        }
    }

    private indexInbounds(): void {
        this.inboundsByTag.clear();
        for (const inbound of this.config.inbounds) {
            this.inboundsByTag.set(inbound.tag, inbound);
        }
    }

    private getNetwork(inbound: ISingBoxInbound): string | null {
        if (inbound.transport?.type) return inbound.transport.type;
        if (typeof inbound.network === 'string') return inbound.network;
        if (Array.isArray(inbound.network)) return inbound.network.join(',');
        switch (inbound.type) {
            case 'anytls':
            case 'trojan':
            case 'vless':
                return 'tcp';
            case 'hysteria2':
            case 'tuic':
                return 'quic';
            default:
                return null;
        }
    }

    private getSecurity(inbound: ISingBoxInbound): string | null {
        if (isSingBoxRealityEnabled(inbound)) return 'reality';
        return inbound.tls?.enabled ? 'tls' : null;
    }

    private parsePort(port: number | undefined): number | null {
        return Number.isInteger(port) ? port! : null;
    }

    private readPemLines(filePath: string): string[] {
        return readFileSync(filePath, 'utf-8')
            .replace(/\r\n/g, '\n')
            .split('\n')
            .filter((line) => line);
    }

    private replaceSnippetsInArray(
        array: TJsonRecord[] | undefined,
        snippetsMap: Map<string, unknown>,
    ): void {
        if (!array) return;

        for (let index = array.length - 1; index >= 0; index--) {
            const snippetName = array[index].snippet;
            if (typeof snippetName !== 'string') continue;

            const snippet = snippetsMap.get(snippetName);
            if (Array.isArray(snippet)) {
                array.splice(index, 1, ...(snippet as TJsonRecord[]));
            } else if (snippet && typeof snippet === 'object') {
                array[index] = snippet as TJsonRecord;
            } else {
                array.splice(index, 1);
            }
        }
    }

    private sortObject(value: unknown): unknown {
        if (Array.isArray(value)) {
            return value.map((item) => this.sortObject(item));
        }
        if (!value || typeof value !== 'object') {
            return value;
        }

        return Object.fromEntries(
            Object.entries(value as TJsonRecord)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, this.sortObject(item)]),
        );
    }
}

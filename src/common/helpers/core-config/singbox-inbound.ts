/**
 * Shared rules for sing-box inbounds whose users are managed by Remnawave.
 *
 * Server user injection, Node user commands and subscription output must all derive credentials
 * and options from these helpers; a mismatch makes clients fail authentication.
 */

export const SINGBOX_MANAGED_INBOUND_TYPES: ReadonlySet<string> = new Set([
    'anytls',
    'hysteria2',
    'shadowsocks',
    'trojan',
    'tuic',
    'vless',
]);

/** Inbound types that sing-box only accepts with TLS enabled. */
const SINGBOX_TLS_REQUIRED_INBOUND_TYPES: ReadonlySet<string> = new Set([
    'anytls',
    'hysteria2',
    'tuic',
]);

/**
 * SS2022 multi-user methods whose user key length matches the 32-character Remnawave `ssPassword`.
 * `2022-blake3-aes-128-gcm` needs 16-byte user keys; `2022-blake3-chacha20-poly1305` has no
 * multi-user identity header.
 */
const SINGBOX_SS2022_METHODS: ReadonlySet<string> = new Set(['2022-blake3-aes-256-gcm']);

const SINGBOX_SS_LEGACY_METHODS: ReadonlySet<string> = new Set([
    'aes-128-gcm',
    'aes-192-gcm',
    'aes-256-gcm',
    'chacha20-ietf-poly1305',
    'xchacha20-ietf-poly1305',
]);

const SS2022_KEY_BYTES = 32;

export type TSingBoxNodeUserType =
    | 'anytls'
    | 'hysteria'
    | 'shadowsocks'
    | 'shadowsocks22'
    | 'trojan'
    | 'tuic'
    | 'vless';

export interface ISingBoxRawInbound {
    type: string;
    tag?: string;
    method?: string;
    password?: string;
    multiplex?: { enabled?: boolean };
    transport?: { type?: string };
    tls?: {
        enabled?: boolean;
        reality?: { enabled?: boolean };
    };
}

export function isSingBoxRawInbound(value: unknown): value is ISingBoxRawInbound {
    if (typeof value !== 'object' || value === null || !('type' in value)) return false;
    return typeof value.type === 'string' && !('protocol' in value && value.protocol !== undefined);
}

export function isSingBoxManagedInbound(inbound: { type: string }): boolean {
    return SINGBOX_MANAGED_INBOUND_TYPES.has(inbound.type);
}

export function isSingBoxTlsRequired(type: string): boolean {
    return SINGBOX_TLS_REQUIRED_INBOUND_TYPES.has(type);
}

export function isSingBoxRealityEnabled(inbound: ISingBoxRawInbound): boolean {
    return inbound.tls?.enabled === true && inbound.tls.reality?.enabled === true;
}

export function isSingBoxSs2022Method(method: string | undefined): boolean {
    return method !== undefined && SINGBOX_SS2022_METHODS.has(method);
}

export function isSingBoxSsMethodSupported(method: string | undefined): boolean {
    return (
        method !== undefined &&
        (SINGBOX_SS2022_METHODS.has(method) || SINGBOX_SS_LEGACY_METHODS.has(method))
    );
}

export function getSingBoxSsSupportedMethods(): string[] {
    return [...SINGBOX_SS2022_METHODS, ...SINGBOX_SS_LEGACY_METHODS];
}

export function isSingBoxSs2022Key(value: string | undefined): boolean {
    return (
        typeof value === 'string' &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
        Buffer.from(value, 'base64').length === SS2022_KEY_BYTES
    );
}

/**
 * Returns the base64 SS2022 user key, or null when the user's `ssPassword` cannot form a valid key.
 * Such users are skipped for SS2022 inbounds: one invalid key would make `sing-box check` reject
 * the whole Node config.
 */
export function getSingBoxSs2022UserKey(ssPassword: string): string | null {
    const key = Buffer.from(ssPassword).toString('base64');
    return Buffer.from(key, 'base64').length === SS2022_KEY_BYTES ? key : null;
}

/** Shadowsocks password for a user, or null when the user cannot use this inbound. */
export function getSingBoxSsUserPassword(
    inbound: ISingBoxRawInbound,
    ssPassword: string,
): string | null {
    return isSingBoxSs2022Method(inbound.method) ? getSingBoxSs2022UserKey(ssPassword) : ssPassword;
}

/**
 * XTLS Vision is used for VLESS over raw TCP with TLS or Reality. It cannot run inside a V2Ray
 * transport or with sing-box multiplex.
 */
export function getSingBoxVlessFlow(inbound: ISingBoxRawInbound): 'xtls-rprx-vision' | '' {
    if (inbound.type !== 'vless') return '';
    if (inbound.transport?.type) return '';
    if (inbound.multiplex?.enabled) return '';
    return inbound.tls?.enabled === true ? 'xtls-rprx-vision' : '';
}

/** Maps a sing-box inbound to the Node add-user command type. */
export function getSingBoxNodeUserType(inbound: ISingBoxRawInbound): TSingBoxNodeUserType | null {
    switch (inbound.type) {
        case 'anytls':
        case 'trojan':
        case 'tuic':
        case 'vless':
            return inbound.type;
        case 'hysteria2':
            return 'hysteria';
        case 'shadowsocks':
            return isSingBoxSs2022Method(inbound.method) ? 'shadowsocks22' : 'shadowsocks';
        default:
            return null;
    }
}

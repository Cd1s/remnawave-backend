# sing-box AnyTLS client compatibility

The fork's AnyTLS protocol output is intentional and must not be rewritten as VLESS or
Trojan. The following compatibility boundary was verified with the official sing-box binary
against the same minimal configuration containing `outbounds[4].type=anytls`:

- sing-box `1.11.4` fails with `unknown outbound type: anytls`.
- sing-box `1.12.0` accepts the configuration and exits successfully.

Therefore:

- sing-box JSON containing an AnyTLS outbound requires sing-box `>= 1.12.0`;
- an AnyTLS URI requires an iOS/client implementation that supports AnyTLS, also at least
  sing-box `1.12.0` where the official sing-box baseline is used;
- Xray JSON does not advertise or claim AnyTLS support;
- an older iOS client must be upgraded, and the AnyTLS outbound must not be downgraded to
  VLESS or Trojan.

This is a client compatibility requirement, not a Zap-Hosting panel configuration defect.

The default sing-box subscription template is validated with the official sing-box `1.14.4`
binary. It uses the `route` `action: sniff` rule instead of removed inbound `sniff` fields,
typed DNS/TCP/TLS/FakeIP servers instead of legacy `address` servers, merged TUN `address`
fields, and `route.default_domain_resolver`. It omits `dns.independent_cache`, which sing-box
1.14 deprecates. The validator fails if `sing-box check` reports any deprecated field, so the
default output does not require `ENABLE_DEPRECATED_*` compatibility environment variables on
current or next-minor clients. Custom SINGBOX templates are not rewritten automatically; they
must be migrated and validated by their owner before use. On startup, the reserved `Default`
template is refreshed only when legacy DNS/inbound markers, including `independent_cache`, are
detected; named custom templates are not overwritten.

The default template also omits the Android-only `route.override_android_vpn` option so the
same subscription JSON can pass the official command-line validator on Linux/macOS. This does
not change the native AnyTLS outbound or the sing-box/Xray core selection behavior.

Mihomo/Clash Meta/Clash Mi output uses the native `type: anytls` proxy schema and therefore
requires a client version that implements that schema. Both the MIHOMO generator and the CLASH
generator (used by the ClashMi user agent) are checked with the pinned official Mihomo `v1.19.29`
binary. Mihomo does not support an AnyTLS+Reality combination, so that combination is explicitly
omitted from both outputs; Reality fields are never fabricated for AnyTLS. Older import layers
that reject `type: anytls` must be upgraded instead of receiving a VLESS or Trojan downgrade.

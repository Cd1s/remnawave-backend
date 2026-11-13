# AI maintainer guide

## Repository role

This is the backend fork for the Remnawave dual-core project.

- Fork: `Cd1s/remnawave-backend`
- Maintained branch: `singbox`
- Upstream: `remnawave/backend` branch `main`
- Published artifact: `ghcr.io/cd1s/remnawave-backend`

The backend remains the authority for the API, database schema, config-profile model, Node
commands, user synchronization, traffic attribution, and subscription generation. The frontend
must consume its contracts, and the Node must remain compatible with the commands it sends.

The cross-repository source of truth is
[`Cd1s/remnawave-singbox`](https://github.com/Cd1s/remnawave-singbox). Read its project map,
feature registry, and upstream maintenance guide before changing behavior shared with the
frontend or Node.

## Fork-specific behavior

The `singbox` branch adds or preserves:

- `config_profiles.core_type`, defaulting to `xray`;
- a core-config abstraction that can process Xray and sing-box profiles;
- preservation of native sing-box JSON field names and inbound JSON;
- sing-box user injection and Node command metadata for AnyTLS, VLESS, Trojan, Shadowsocks,
  Hysteria2 and TUIC inbounds;
- sing-box JSON, Mihomo/Stash and share-link (Shadowrocket) output for those inbounds;
- Xray-compatible API paths, response fields, existing profiles, subscriptions, and migrations;
- tested upstream synchronization and multi-architecture fork images.

Important implementation areas include:

- `src/common/helpers/core-config/`
- `src/common/axios/node-contract-extensions.ts`
- `src/modules/config-profiles/`
- `src/modules/nodes/`
- `src/modules/subscription-template/`
- `src/modules/users/queries/get-prepared-config-with-users/`
- `prisma/migrations/`
- `scripts/validate-seed-core-inbounds.cjs`
- `scripts/validate-shadowrocket-anytls.cjs`
- `scripts/validate-singbox-inbounds.cjs`

Do not assume this list is exhaustive. Compare the branch with `upstream/main` before modifying
fork behavior:

```bash
git diff --name-status upstream/main...HEAD
git log --oneline upstream/main..HEAD
```

## Compatibility invariants

These conditions must remain true after every upstream merge or custom feature:

1. Existing and newly migrated profiles use Xray unless `coreType` is explicitly `singbox`.
2. Existing Xray routes and wire fields continue to work.
3. A sing-box profile survives API storage and retrieval without camel-casing native JSON keys.
4. Updating or starting a sing-box profile does not discard its inbounds.
5. Managed sing-box users use the established Remnawave identity mapping (name = user ID) and
   remain attributable in traffic statistics. `singbox-inbound.ts` owns the credential rules for
   injection, Node commands and subscriptions alike.
6. Xray JSON subscriptions do not claim support for AnyTLS or TUIC.
7. Shadowrocket, Mihomo and sing-box subscription output remains covered by regression validation.
8. Database migrations are additive and safe for an existing Xray installation. Never rewrite or
   delete an already published migration to resolve an upstream conflict.

## How to add a custom feature

Before implementation, add or update the feature in the central
`docs/custom-feature-registry.md`. Identify whether the feature also requires frontend or Node
changes.

Prefer:

- new modules, adapters, validators, and narrow contract extensions;
- explicit core-type branching at the boundary;
- backward-compatible optional fields;
- additive migrations with safe defaults;
- focused regression tests for every custom invariant.

Avoid:

- broad rewrites of upstream services;
- renaming upstream routes or fields only for the fork;
- silently converting Xray data to sing-box;
- using deployment-specific addresses, credentials, or certificates in source or tests;
- fixing a cross-repository contract in only one repository.

If upstream later implements equivalent behavior, adapt the fork to upstream's model and remove
the custom path only after migration, subscription, Xray compatibility, and Node integration tests
pass.

## Upstream synchronization failure

The scheduled workflow fetches `https://github.com/remnawave/backend.git` `main` into a temporary
GitHub Actions checkout. It detects updates by commit ancestry, not by `package.json` semver. A
`git merge-tree` preflight reports overlap and refuses conflicts before changing the checkout. A
clean merge runs the fork adaptation preflight, then the build, validators, formatter, and linter;
only that tested merge is pushed and used for image publication. A conflict or failed test leaves
`origin/singbox` unchanged and produces an auditable report instead of silently choosing one side.

If upstream is already an ancestor, the workflow succeeds without pushing or rebuilding. If
upstream changed, cleanly merged files that overlap the fork still require all adaptation gates;
the overlap count is an audit signal, not a waiver. The merged package version is read dynamically
for image metadata and is never used to decide whether an update exists. See
`docs/upstream-sync.md` and `docs/custom-feature-registry.md` for the operator behavior and
backend-owned invariants.

To repair a failure:

1. Fetch both remotes and create a temporary repair branch from `origin/singbox`.
2. Merge `upstream/main`; do not rebase or force-push the maintained branch.
3. Resolve conflicts by preserving upstream behavior and reapplying the compatibility invariants
   above.
4. Inspect all upstream changes around every conflicted service, contract, migration, and
   generator. A compile-only resolution is insufficient.
5. Run the validation gates below.
6. If shared contracts changed, validate the matching frontend and Node branches before merging.
7. Merge the repair into `singbox`; allow normal CI to publish artifacts.

Never bypass a failing custom validator merely to make automatic synchronization green.

## Validation gates

Use Node.js 24 and run:

```bash
npm ci --no-audit --no-fund
npm run build
npm run build:seed
npm run validate:seed-core-inbounds
npm run validate:shadowrocket-anytls
SINGBOX_BIN=... MIHOMO_BIN=... npm run validate:singbox-inbounds
npm run check
```

For changes involving runtime commands, subscriptions, users, migrations, or core selection, also
run the isolated full-stack validation documented in the central repository.

## Definition of done

A backend change is complete only when:

- fork-specific and upstream behavior both pass;
- the feature registry reflects any changed ownership or invariant;
- related frontend and Node contracts are compatible;
- no secrets or infrastructure identifiers were committed;
- release notes identify the tested source commit and immutable image digest when an image is
  published.

#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT/.github/scripts/upstream-sync-lib.sh"
WORKFLOW="$ROOT/.github/workflows/upstream-sync.yml"
failures=0

fail() { printf 'not ok - %s\n' "$1" >&2; failures=$((failures + 1)); }
pass() { printf 'ok - %s\n' "$1"; }
contains() { grep -Fq -- "$2" <<<"$1"; }
file_contains() { grep -Fq -- "$2" "$1"; }

make_repo() {
    fixture_root="$(mktemp -d)"
    repo="$fixture_root/repo"
    origin="$fixture_root/origin.git"
    mkdir -p "$repo"
    git init -q "$repo"
    git -C "$repo" config user.name test
    git -C "$repo" config user.email test@example.invalid
    git -C "$repo" checkout -q -b singbox
    printf 'base\n' >"$repo/state"
    git -C "$repo" add state
    git -C "$repo" commit -q -m base
    git init -q --bare "$origin"
    git -C "$repo" remote add origin "$origin"
    git -C "$repo" push -q origin HEAD:singbox
    printf 'fork\n' >>"$repo/state"
    git -C "$repo" add state
    git -C "$repo" commit -q -m fork
    maintained_sha="$(git -C "$repo" rev-parse HEAD)"
    git -C "$repo" checkout -q -b upstream-main HEAD~1
    printf 'upstream\n' >>"$repo/upstream-only"
    git -C "$repo" add upstream-only
    git -C "$repo" commit -q -m upstream
    upstream_sha="$(git -C "$repo" rev-parse HEAD)"
    git -C "$repo" checkout -q singbox
    mock_bin="$fixture_root/bin"
    mkdir -p "$mock_bin"
    real_git="$(command -v git)"
    cat >"$mock_bin/git" <<'EOF'
#!/usr/bin/env bash
set -eu
if [ "${1:-}" = ls-remote ]; then
    printf '%s\trefs/tags/%s^{}\n' "$FAKE_UPSTREAM_COMMIT" "$FAKE_TAG"
    exit 0
fi
if [ "${1:-}" = push ] && [ "${2:-}" = --dry-run ] && [ "${FAIL_DRY_RUN:-0}" = 1 ]; then
    exit 77
fi
if [ "${1:-}" = merge ] && [ "${2:-}" = --abort ] && [ "${FAKE_ABORT:-0}" = 1 ]; then
    exit 77
fi
exec "$REAL_GIT" "$@"
EOF
    chmod +x "$mock_bin/git"
}

run_lib() {
    local subcommand=$1
    shift
    ( cd "$repo"; PATH="$mock_bin:$PATH" GIT_BIN="$mock_bin/git" REAL_GIT="$real_git" "$@" bash "$LIB" "$subcommand" )
}

test_release_resolver_stable_and_prerelease() {
    make_repo
    cat >"$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
if [ "${1:-}" = api ]; then
    printf '%s\n' '[{"tag_name":"3.1.0","html_url":"https://example.invalid/3.1.0","published_at":"2026-07-01T00:00:00Z","draft":false,"prerelease":false},{"tag_name":"3.2.0-rc.1","html_url":"https://example.invalid/rc","published_at":"2026-08-01T00:00:00Z","draft":false,"prerelease":true},{"tag_name":"3.2.0","html_url":"https://example.invalid/3.2.0","published_at":"2026-08-02T00:00:00Z","draft":false,"prerelease":false}]'
    exit 0
fi
exit 2
EOF
    chmod +x "$mock_bin/gh"
    output="$fixture_root/output"
    ( cd "$repo"; PATH="$mock_bin:$PATH" GIT_BIN="$mock_bin/git" REAL_GIT="$real_git" FAKE_UPSTREAM_COMMIT="$upstream_sha" FAKE_TAG=3.2.0 UPSTREAM_REPO=remnawave/test GITHUB_OUTPUT="$output" bash "$LIB" resolve ) >/dev/null 2>&1 || return 1
    file_contains "$output" 'tag=3.2.0' || return 1
    file_contains "$output" 'version=3.2.0' || return 1
    file_contains "$output" "commit=$upstream_sha"
}

test_release_resolver_empty_is_classified() {
    make_repo
    cat >"$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' '[]'
EOF
    chmod +x "$mock_bin/gh"
    output="$fixture_root/output"
    result="$(cd "$repo"; PATH="$mock_bin:$PATH" GITHUB_OUTPUT="$output" UPSTREAM_REPO=remnawave/test bash "$LIB" resolve 2>&1)" && return 1
    contains "$result" 'reason=no_stable_release'
}

test_release_resolver_network_is_classified() {
    make_repo
    cat >"$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'network unavailable' >&2
exit 28
EOF
    chmod +x "$mock_bin/gh"
    output="$fixture_root/output"
    result="$(cd "$repo"; PATH="$mock_bin:$PATH" GITHUB_OUTPUT="$output" UPSTREAM_REPO=remnawave/test bash "$LIB" resolve 2>&1)" && return 1
    contains "$result" 'reason=release_query_error'
}
test_historical_tag_collision_fetch_is_safe() {
    fixture_root="$(mktemp -d)"
    repo="$fixture_root/repo"
    upstream_source="$fixture_root/upstream-source"
    upstream="$fixture_root/upstream.git"
    mkdir -p "$repo" "$upstream_source"
    git init -q "$repo"
    git -C "$repo" config user.name test
    git -C "$repo" config user.email test@example.invalid
    git -C "$repo" checkout -q -b singbox
    printf 'fork\n' >"$repo/state"
    git -C "$repo" add state
    git -C "$repo" commit -q -m fork
    fork_tag_sha="$(git -C "$repo" rev-parse HEAD)"
    git -C "$repo" tag 3.2.0
    git init -q "$upstream_source"
    git -C "$upstream_source" config user.name upstream
    git -C "$upstream_source" config user.email upstream@example.invalid
    git -C "$upstream_source" checkout -q -b main
    printf 'upstream\n' >"$upstream_source/state"
    git -C "$upstream_source" add state
    git -C "$upstream_source" commit -q -m upstream
    upstream_sha="$(git -C "$upstream_source" rev-parse HEAD)"
    git -C "$upstream_source" tag 3.2.0
    git init -q --bare "$upstream"
    git -C "$upstream_source" remote add origin "$upstream"
    git -C "$upstream_source" push -q origin main refs/tags/3.2.0
    git -C "$repo" remote add upstream "$upstream"

    # RED: this is the previous workflow command and must fail on a fork-owned tag collision.
    git -C "$repo" fetch --no-tags upstream main >/dev/null 2>&1 || return 1
    [ "$(git -C "$repo" rev-parse refs/tags/3.2.0)" = "$fork_tag_sha" ] || return 1
    [ "$(git -C "$repo" rev-parse refs/remotes/upstream/main)" = "$upstream_sha" ] || return 1
    ! file_contains "$WORKFLOW" 'git fetch --force' || return 1
    ! file_contains "$WORKFLOW" 'refs/tags/${{ steps.release.outputs.tag }}:refs/tags/upstream-release-${{ steps.release.outputs.tag }}'
}

test_clean_merge_and_already_up_to_date() {
    make_repo
    output="$(cd "$repo"; PATH="$mock_bin:$PATH" GIT_BIN="$mock_bin/git" REAL_GIT="$real_git" UPSTREAM_REF="$upstream_sha" UPSTREAM_SYNC_REPORT_PATH="$fixture_root/report" bash "$LIB" merge 2>&1)" || return 1
    contains "$output" 'upstream_sync=merged' || return 1
    output="$(cd "$repo"; PATH="$mock_bin:$PATH" GIT_BIN="$mock_bin/git" REAL_GIT="$real_git" UPSTREAM_REF="$upstream_sha" UPSTREAM_SYNC_REPORT_PATH="$fixture_root/report" bash "$LIB" merge 2>&1)" || return 1
    contains "$output" 'upstream_sync=up_to_date'
}

test_conflict_reports_and_aborts_without_push() {
    make_repo
    git -C "$repo" checkout -q -b upstream-conflict HEAD~1
    printf 'upstream\n' >"$repo/state"
    git -C "$repo" add state
    git -C "$repo" commit -q -m conflicting-upstream
    conflict_sha="$(git -C "$repo" rev-parse HEAD)"
    git -C "$repo" checkout -q singbox
    report="$fixture_root/conflict.md"
    output="$(cd "$repo"; PATH="$mock_bin:$PATH" GIT_BIN="$mock_bin/git" REAL_GIT="$real_git" UPSTREAM_REF="$conflict_sha" UPSTREAM_SYNC_REPORT_PATH="$report" bash "$LIB" merge 2>&1)" && return 1
    contains "$output" 'upstream_sync=conflict' || return 1
    file_contains "$report" 'maintained SHA:' || return 1
    file_contains "$report" 'upstream SHA:' || return 1
    file_contains "$report" 'state' || return 1
    [ "$(git -C "$repo" rev-parse HEAD)" = "$maintained_sha" ] || return 1
    [ -z "$(git -C "$repo" status --porcelain)" ]
}

test_merge_abort_failure_is_not_hidden() {
    make_repo
    git -C "$repo" checkout -q -b upstream-conflict HEAD~1
    printf 'upstream\n' >"$repo/state"
    git -C "$repo" add state
    git -C "$repo" commit -q -m conflicting-upstream
    conflict_sha="$(git -C "$repo" rev-parse HEAD)"
    git -C "$repo" checkout -q singbox
    report="$fixture_root/abort-failure.md"
    output="$(cd "$repo"; PATH="$mock_bin:$PATH" GIT_BIN="$mock_bin/git" REAL_GIT="$real_git" FAKE_ABORT=1 UPSTREAM_REF="$conflict_sha" UPSTREAM_SYNC_REPORT_PATH="$report" bash "$LIB" merge 2>&1)" && return 1
    contains "$output" 'reason=merge_abort_failed'
}

test_config_profile_conflict_resolution_preserves_dual_core_paths() {
    service="$ROOT/src/modules/config-profiles/config-profile.service.ts"
    file_contains "$service" 'createCoreConfig' || return 1
    file_contains "$service" 'CONFIG_PROFILE_CORE_TYPE' || return 1
    file_contains "$service" 'coreType?: TConfigProfileCoreType' || return 1
    file_contains "$service" 'if (nextCoreType === CONFIG_PROFILE_CORE_TYPE.XRAY)' || return 1
    file_contains "$service" 'validatedConfig.validateOutbounds?.()' || return 1
    ! file_contains "$service" 'new XRayConfig'
}

test_package_contract_uses_release_commit_and_monorepo_paths() {
    make_repo
    printf '{"name":"root","version":"2.8.0"}\n' >"$repo/package.json"
    mkdir -p "$repo/libs/contract"
    printf '{"name":"contract","version":"2.8.0"}\n' >"$repo/libs/contract/package.json"
    git -C "$repo" add package.json libs/contract/package.json
    git -C "$repo" commit -q -m packages
    git -C "$repo" checkout -q -b upstream-packages HEAD~1
    printf '{"name":"root","version":"3.2.0"}\n' >"$repo/package.json"
    mkdir -p "$repo/libs/contract"
    printf '{"name":"contract","version":"3.2.0"}\n' >"$repo/libs/contract/package.json"
    git -C "$repo" add package.json libs/contract/package.json
    git -C "$repo" commit -q -m upstream-packages
    package_sha="$(git -C "$repo" rev-parse HEAD)"
    git -C "$repo" checkout -q singbox
    result="$(cd "$repo"; PATH="$mock_bin:$PATH" GIT_BIN="$mock_bin/git" REAL_GIT="$real_git" UPSTREAM_REF="$package_sha" PACKAGE_PATHS='package.json,libs/contract/package.json' bash "$LIB" package 2>&1)" && return 1
    contains "$result" 'package_version_mismatch' || return 1
    git -C "$repo" checkout -q "$package_sha" -- package.json libs/contract/package.json
    result="$(cd "$repo"; PATH="$mock_bin:$PATH" GIT_BIN="$mock_bin/git" REAL_GIT="$real_git" UPSTREAM_REF="$package_sha" PACKAGE_PATHS='package.json,libs/contract/package.json' bash "$LIB" package 2>&1)" || return 1
    contains "$result" 'package_contract=passed'
}

test_capability_preflight_fails_before_build() {
    make_repo
    cat >"$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
case "${GH_BEHAVIOR:-ok}" in
    workflow-denied) [ "${2:-}" != repos/Cd1s/test/actions/workflows ] || { echo 'workflow permission denied' >&2; exit 1; } ;;
esac
if [ "${1:-}" = api ]; then
    case "${2:-}" in
        repos/Cd1s/test) printf '{"permissions":{"push":true}}\n' ;;
        forbidden/packages*) printf '[]\n' ;;
        *) printf '{}\n' ;;
    esac
    exit 0
fi
exit 2
EOF
    chmod +x "$mock_bin/gh"
    result="$(cd "$repo"; PATH="$mock_bin:$PATH" GITHUB_REPOSITORY=Cd1s/test WORKFLOW_TOKEN=present GH_TOKEN=present PACKAGE_TOKEN=present SKIP_GIT_DRY_RUN=true GH_BEHAVIOR=workflow-denied bash "$LIB" preflight 2>&1)" && return 1
    contains "$result" 'reason=workflows_write_denied'
}

test_capability_preflight_does_not_trust_actions_context() {
    make_repo
    cat >"$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
if [ "${1:-}" = api ]; then
    case "${2:-}" in
        repos/Cd1s/test) printf '{"permissions":{"push":false}}\n' ;;
        *) printf '{}\n' ;;
    esac
    exit 0
fi
exit 2
EOF
    chmod +x "$mock_bin/gh"
    result="$(cd "$repo"; PATH="$mock_bin:$PATH" GITHUB_REPOSITORY=Cd1s/test WORKFLOW_TOKEN=present GH_TOKEN=present PACKAGE_TOKEN=present SKIP_GIT_DRY_RUN=true GITHUB_ACTIONS=true bash "$LIB" preflight 2>&1)" && return 1
    contains "$result" 'reason=contents_write_denied'
}

test_capability_preflight_uses_package_token() {
    make_repo
    cat >"$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
if [ "${1:-}" = api ]; then
    case "${2:-}" in
        repos/Cd1s/test) printf '{"permissions":{"push":true}}\n' ;;
        forbidden/packages*) [ "${GH_TOKEN:-}" = package-token ] || { echo 'package token denied' >&2; exit 1; } ;;
        *) printf '{}\n' ;;
    esac
    exit 0
fi
exit 2
EOF
    chmod +x "$mock_bin/gh"
    result="$(cd "$repo"; PATH="$mock_bin:$PATH" GITHUB_REPOSITORY=Cd1s/test WORKFLOW_TOKEN=workflow-token PACKAGE_TOKEN=package-token GH_TOKEN=workflow-token SKIP_GIT_DRY_RUN=true bash "$LIB" preflight 2>&1)" || return 1
    contains "$result" 'capability_preflight=passed'
}

test_capability_preflight_rejects_missing_workflow_token_v2() {
    make_repo
    result="$(cd "$repo"; PATH="$mock_bin:$PATH" GITHUB_REPOSITORY=Cd1s/test WORKFLOW_TOKEN= bash "$LIB" preflight 2>&1)" && return 1
    contains "$result" 'reason=missing_WORKFLOW_TOKEN requires_contents_workflows_packages_release_write'
}

test_capability_preflight_rejects_actions_bypass_v2() {
    make_repo
    cat >"$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
if [ "${1:-}" = api ]; then
    case "${2:-}" in
        repos/Cd1s/test) printf '{"permissions":{"push":false}}\n' ;;
        *) printf '{}\n' ;;
    esac
    exit 0
fi
exit 2
EOF
    chmod +x "$mock_bin/gh"
    result="$(cd "$repo"; PATH="$mock_bin:$PATH" GITHUB_REPOSITORY=Cd1s/test WORKFLOW_TOKEN=present GH_TOKEN=present PACKAGE_TOKEN=present SKIP_GIT_DRY_RUN=true GITHUB_ACTIONS=true bash "$LIB" preflight 2>&1)" && return 1
    contains "$result" 'reason=contents_write_denied'
}

test_workflow_contract_and_order() {
    ! file_contains "$WORKFLOW" 'schedule:' || return 1
    ! file_contains "$WORKFLOW" '*/5 * * * *' || return 1
    [ -z "$(awk '/^jobs:/{exit} /\$\{\{ runner\.temp \}\}/{print NR}' "$WORKFLOW")" ] || return 1
    file_contains "$WORKFLOW" 'workflow_dispatch:' || return 1
    file_contains "$WORKFLOW" 'cancel-in-progress: false' || return 1
    file_contains "$WORKFLOW" 'WORKFLOW_TOKEN' || return 1
    file_contains "$WORKFLOW" 'upstream-sync-lib.sh preflight' || return 1
    file_contains "$WORKFLOW" 'upstream-sync-lib.sh package' || return 1
    ! file_contains "$WORKFLOW" 'refs/tags/${{ steps.release.outputs.tag }}:refs/tags/upstream-release-${{ steps.release.outputs.tag }}' || return 1
    file_contains "$WORKFLOW" 'git fetch --no-tags upstream main' || return 1
    file_contains "$WORKFLOW" 'git fetch --no-tags upstream "$UPSTREAM_REF"' || return 1
    file_contains "$WORKFLOW" 'Install official sing-box 1.14.4 validator' || return 1
    file_contains "$WORKFLOW" 'Install official Mihomo validator' || return 1
    file_contains "$WORKFLOW" 'token: ${{ secrets.GITHUB_TOKEN }}' || return 1
    ! file_contains "$WORKFLOW" 'token: ${{ secrets.WORKFLOW_TOKEN }}' || return 1
    file_contains "$WORKFLOW" 'GH_TOKEN: ${{ github.token }}' || return 1
    ! file_contains "$WORKFLOW" 'GH_TOKEN: ${{ secrets.WORKFLOW_TOKEN || secrets.GITHUB_TOKEN }}' || return 1
    file_contains "$WORKFLOW" 'GITHUB_TOKEN: ${{ github.token }}' || return 1
    file_contains "$WORKFLOW" 'password: ${{ github.token }}' || return 1
    file_contains "$WORKFLOW" 'workflow_token_query_error' || return 1
    file_contains "$WORKFLOW" 'WORKFLOW_CHANGED: ${{ steps.sync.outputs.workflow_changed }}' || return 1
    file_contains "$WORKFLOW" 'push_token="$GITHUB_TOKEN"' || return 1
    file_contains "$WORKFLOW" 'push_token="$WORKFLOW_TOKEN"' || return 1
    ! file_contains "$WORKFLOW" 'PACKAGE_TOKEN' || return 1
    ! file_contains "$WORKFLOW" 'actions/workflows' || return 1
    ! file_contains "$WORKFLOW" 'permissions.push' || return 1
    file_contains "$WORKFLOW" 'WORKFLOW_TOKEN: ${{ secrets.WORKFLOW_TOKEN }}'
    file_contains "$WORKFLOW" 'PACKAGE_PUBLISH_REQUIRED: true' || return 1
    file_contains "$WORKFLOW" 'GIT_CONFIG_KEY_0=http.https://github.com/.extraheader' || return 1
    ! file_contains "$WORKFLOW" 'Configure ephemeral GitHub auth for push' || return 1
    file_contains "$WORKFLOW" 'GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth_header"' || return 1
    file_contains "$WORKFLOW" 'actions/upload-artifact@v4' || return 1
    file_contains "$WORKFLOW" 'git push origin HEAD:singbox' || return 1
    preflight_line="$(grep -n -m1 'upstream-sync-lib.sh preflight' "$WORKFLOW" | cut -d: -f1)" || return 1
    docker_line="$(grep -n -m1 'docker/build-push-action' "$WORKFLOW" | cut -d: -f1)" || return 1
    [ "$preflight_line" -lt "$docker_line" ] || return 1
}

test_push_auth_never_duplicates_checkout_extraheader() {
    file_contains "$WORKFLOW" 'GITHUB_TOKEN: ${{ github.token }}' || return 1
    file_contains "$WORKFLOW" 'WORKFLOW_CHANGED: ${{ steps.sync.outputs.workflow_changed }}' || return 1
    file_contains "$WORKFLOW" 'push_token="$GITHUB_TOKEN"' || return 1
    file_contains "$WORKFLOW" 'push_token="$WORKFLOW_TOKEN"' || return 1
    [ "$(grep -Fc 'GIT_CONFIG_COUNT=1' "$WORKFLOW")" -eq 2 ] || return 1
    file_contains "$WORKFLOW" 'GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth_header"' || return 1
}

test_capability_preflight_rejects_forbidden_probes() {
    make_repo
    call_log="$fixture_root/gh.log"
    cat >"$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >>"$GH_CALL_LOG"
if [ "${1:-}" = api ]; then
    case "${2:-}" in
        repos/Cd1s/test) printf '{"id":123}\n' ;;
        "repos/Cd1s/test/releases?per_page=1") printf '[]\n' ;;
        "repos/Cd1s/test/actions/workflows"|forbidden/packages*) exit 97 ;;
        *) exit 2 ;;
    esac
    exit 0
fi
exit 2
EOF
    chmod +x "$mock_bin/gh"
    result="$(cd "$repo"; PATH="$mock_bin:$PATH" GIT_BIN="$mock_bin/git" REAL_GIT="$real_git" GH_CALL_LOG="$call_log" GITHUB_REPOSITORY=Cd1s/test GH_TOKEN=github-token WORKFLOW_CHANGED=false bash "$LIB" preflight 2>&1)" || return 1
    contains "$result" 'capability_preflight=passed' || return 1
    ! grep -Fq 'actions/workflows' "$call_log" && ! grep -Fq 'forbidden/packages' "$call_log"
}

test_workflow_diff_without_token_fails_closed() {
    make_repo
    result="$(cd "$repo"; PATH="$mock_bin:$PATH" GITHUB_REPOSITORY=Cd1s/test WORKFLOW_CHANGED=true WORKFLOW_TOKEN= bash "$LIB" preflight 2>&1)" && return 1
    contains "$result" 'reason=missing_WORKFLOW_TOKEN workflow_files_changed'
}

test_workflow_diff_with_invalid_token_fails_closed() {
    make_repo
    cat >"$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
[ "${1:-}" = api ] || exit 2
[ "${2:-}" = user ] && exit 1
printf '{"id":123}\n'
EOF
    chmod +x "$mock_bin/gh"
    result="$(cd "$repo"; PATH="$mock_bin:$PATH" GITHUB_REPOSITORY=Cd1s/test GH_TOKEN=github-token WORKFLOW_CHANGED=true WORKFLOW_TOKEN=bad-token bash "$LIB" preflight 2>&1)" && return 1
    contains "$result" 'reason=workflow_token_query_error'
}

test_package_publish_capability_uses_builtin_token() {
    make_repo
    call_log="$fixture_root/gh.log"
    cat >"$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >>"$GH_CALL_LOG"
if [ "${1:-}" = api ]; then
    case "${2:-}" in
        repos/Cd1s/test) printf '123\n' ;;
        repos/Cd1s/test/releases?per_page=1) printf '[]\n' ;;
        user)
            [ "${3:-}" = --include ] || exit 2
            if [ "${PACKAGE_SCOPE:-write}" = write ]; then
                printf 'X-OAuth-Scopes: repo, workflow, write:packages\n\n{}\n'
            else
                printf 'X-OAuth-Scopes: repo, workflow\n\n{}\n'
            fi
            ;;
        *) exit 2 ;;
    esac
    exit 0
fi
exit 2
EOF
    chmod +x "$mock_bin/gh"
    cat >"$mock_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -eu
[ "${1:-}" = login ] && [ "${2:-}" = ghcr.io ]
cat >/dev/null
EOF
    chmod +x "$mock_bin/docker"
    result="$(cd "$repo"; PATH="$mock_bin:$PATH" GIT_BIN="$mock_bin/git" REAL_GIT="$real_git" GH_CALL_LOG="$call_log" GITHUB_REPOSITORY=Cd1s/test GH_TOKEN=builtin-token WORKFLOW_TOKEN=bad-token PACKAGE_PUBLISH_REQUIRED=true bash "$LIB" preflight 2>&1)" || return 1
    contains "$result" 'package_publish_capability=verified method=ghcr-login token=builtin' || return 1
    ! grep -Fq -- 'user --include' "$call_log"
}

run_case() { if "$1"; then pass "$1"; else fail "$1"; fi; }
run_case test_release_resolver_stable_and_prerelease
run_case test_release_resolver_empty_is_classified
run_case test_release_resolver_network_is_classified
run_case test_historical_tag_collision_fetch_is_safe
run_case test_clean_merge_and_already_up_to_date
run_case test_conflict_reports_and_aborts_without_push
run_case test_merge_abort_failure_is_not_hidden
run_case test_config_profile_conflict_resolution_preserves_dual_core_paths
run_case test_package_contract_uses_release_commit_and_monorepo_paths
run_case test_capability_preflight_rejects_forbidden_probes
run_case test_workflow_diff_without_token_fails_closed
run_case test_workflow_diff_with_invalid_token_fails_closed
run_case test_package_publish_capability_uses_builtin_token
run_case test_workflow_contract_and_order
run_case test_push_auth_never_duplicates_checkout_extraheader

if [ "$failures" -ne 0 ]; then
    printf '%s test(s) failed\n' "$failures" >&2
    exit 1
fi
printf 'all upstream hardening tests passed\n'

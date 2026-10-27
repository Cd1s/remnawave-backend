#!/usr/bin/env bash
set -euo pipefail

git_bin="${GIT_BIN:-git}"
git_cmd() { "$git_bin" "$@"; }

gh_with_sync_token() {
    if [ "${WORKFLOW_CHANGED:-false}" = true ]; then
        GH_TOKEN="${WORKFLOW_TOKEN:?WORKFLOW_TOKEN is required for workflow changes}" gh "$@"
    else
        gh "$@"
    fi
}

fail_reason() {
    if [ -n "${UPSTREAM_SYNC_REPORT_PATH:-}" ]; then
        mkdir -p "$(dirname "$UPSTREAM_SYNC_REPORT_PATH")"
        {
            echo '# Upstream synchronization failed'
            echo
            echo "- maintained SHA: \`$(git_cmd rev-parse HEAD 2>/dev/null || echo unknown)\`"
            echo "- reason: \`$*\`"
        } >"$UPSTREAM_SYNC_REPORT_PATH"
    fi
    echo "upstream_sync=failed reason=$*" >&2
    exit 1
}

# The paginated releases list intermittently returns []; retry before treating it as "no stable release".
releases_with_retry() {
    local out="" attempt
    for attempt in 1 2 3; do
        if out="$(gh api "repos/${UPSTREAM_REPO}/releases?per_page=100")" && [ "$out" != "[]" ]; then
            printf '%s\n' "$out"
            return 0
        fi
        [ "$attempt" = 3 ] || sleep 10
    done
    [ -n "$out" ] && printf '%s\n' "$out"
}

resolve_release() {
    : "${UPSTREAM_REPO:?UPSTREAM_REPO is required}"
    : "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
    release_error="$(mktemp)"
    if ! release_json="$(releases_with_retry 2>"$release_error")"; then
        cat "$release_error" >&2
        fail_reason release_query_error repo="$UPSTREAM_REPO"
    fi
    if ! selected="$(jq -c '[.[] | select(.draft == false and .prerelease == false) | select(.tag_name != null and .tag_name != "")] | sort_by(.published_at) | last // empty' <<<"$release_json")"; then
        fail_reason release_response_malformed repo="$UPSTREAM_REPO"
    fi
    if [ -z "$selected" ] || [ "$selected" = null ]; then
        fail_reason no_stable_release repo="$UPSTREAM_REPO"
    fi
    release_tag="$(jq -r '.tag_name' <<<"$selected")"
    release_version="${release_tag#v}"
    release_url="$(jq -r '.html_url // .url // empty' <<<"$selected")"
    release_published_at="$(jq -r '.published_at // empty' <<<"$selected")"
    [ -n "$release_tag" ] && [ -n "$release_version" ] || fail_reason latest_release_tag_missing repo="$UPSTREAM_REPO"

    tag_error="$(mktemp)"
    if ! tag_refs="$(git_cmd ls-remote "https://github.com/${UPSTREAM_REPO}.git" "refs/tags/${release_tag}" "refs/tags/${release_tag}^{}" 2>"$tag_error")"; then
        cat "$tag_error" >&2
        fail_reason release_tag_query_error tag="$release_tag"
    fi
    release_commit=""
    while IFS=$'\t' read -r sha ref; do
        case "$ref" in
            "refs/tags/${release_tag}^{}") release_commit="$sha" ;;
            "refs/tags/${release_tag}") [ -n "$release_commit" ] || release_commit="$sha" ;;
        esac
    done <<<"$tag_refs"
    [ -n "$release_commit" ] || fail_reason release_tag_commit_missing tag="$release_tag"
    {
        printf 'tag=%s\n' "$release_tag"
        printf 'version=%s\n' "$release_version"
        printf 'url=%s\n' "$release_url"
        printf 'published_at=%s\n' "$release_published_at"
        printf 'commit=%s\n' "$release_commit"
    } >>"$GITHUB_OUTPUT"
    echo "official_release repo=$UPSTREAM_REPO tag=$release_tag version=$release_version commit=$release_commit"
}

write_conflict_report() {
    report_path="${UPSTREAM_SYNC_REPORT_PATH:-upstream-sync-report.md}"
    mkdir -p "$(dirname "$report_path")"
    {
        echo '# Upstream synchronization stopped: merge conflict'
        echo
        echo 'The maintained branch was not pushed.'
        echo
        echo "- maintained SHA: \`$maintained_sha\`"
        echo "- upstream SHA: \`$upstream_sha\`"
        echo "- status before abort:"
        echo '```text'
        printf '%s\n' "$status_output"
        echo '```'
        echo
        echo '## Conflicting files'
        if [ -n "$conflict_files" ]; then
            while IFS= read -r file; do printf '%s\n' "- \`$file\`"; done <<<"$conflict_files"
        else
            echo '- none (see merge output below)'
        fi
        echo
        echo '## Merge output'
        echo '```text'
        printf '%s\n' "$merge_output"
        echo '```'
    } >"$report_path"
}

merge_upstream() {
    : "${UPSTREAM_REF:?UPSTREAM_REF is required}"
    maintained_sha="$(git_cmd rev-parse HEAD)"
    upstream_sha="$(git_cmd rev-parse --verify "$UPSTREAM_REF")" || fail_reason upstream_ref_missing ref="$UPSTREAM_REF"
    if git_cmd merge-base --is-ancestor "$upstream_sha" HEAD; then
        echo 'updated=false' >>"${GITHUB_OUTPUT:-/dev/null}"
        echo 'workflow_changed=false' >>"${GITHUB_OUTPUT:-/dev/null}"
        echo "upstream_sync=up_to_date maintained=$maintained_sha upstream=$upstream_sha"
        return 0
    fi
    if git_cmd merge-base HEAD "$upstream_sha" >/dev/null 2>&1; then :; else fail_reason merge_base_failed maintained="$maintained_sha" upstream="$upstream_sha"; fi
    merge_log="$(mktemp)"
    if git_cmd merge --no-edit "$upstream_sha" >"$merge_log" 2>&1; then
        final_sha="$(git_cmd rev-parse HEAD)"
        workflow_changed=false
        if [ -n "$(git_cmd diff --name-only "$maintained_sha" "$final_sha" -- .github/workflows)" ]; then
            workflow_changed=true
        fi
        echo 'updated=true' >>"${GITHUB_OUTPUT:-/dev/null}"
        echo "workflow_changed=$workflow_changed" >>"${GITHUB_OUTPUT:-/dev/null}"
        echo "upstream_sync=merged maintained=$maintained_sha upstream=$upstream_sha final=$final_sha workflow_changed=$workflow_changed"
        return 0
    else
        merge_rc=$?
    fi
    merge_output="$(cat "$merge_log")"
    conflict_files="$(git_cmd diff --name-only --diff-filter=U || true)"
    status_output="$(git_cmd status --short || true)"
    write_conflict_report
    if ! git_cmd merge --abort >/dev/null 2>&1; then
        echo "upstream_sync=failed reason=merge_abort_failed maintained=$maintained_sha upstream=$upstream_sha report=${UPSTREAM_SYNC_REPORT_PATH:-upstream-sync-report.md}" >&2
        exit 1
    fi
    echo "upstream_sync=conflict maintained=$maintained_sha upstream=$upstream_sha report=${UPSTREAM_SYNC_REPORT_PATH:-upstream-sync-report.md}" >&2
    exit "$merge_rc"
}

package_contract() {
    : "${UPSTREAM_REF:?UPSTREAM_REF is required}"
    paths="${PACKAGE_PATHS:-package.json}"
    IFS=',' read -r -a package_paths <<<"$paths"
    for package_path in "${package_paths[@]}"; do
        [ -f "$package_path" ] || fail_reason package_file_missing path="$package_path"
        expected_json="$(git_cmd show "$UPSTREAM_REF:$package_path")" || fail_reason package_source_missing path="$package_path" upstream="$UPSTREAM_REF"
        expected="$(jq -er '.version // empty' <<<"$expected_json")" || fail_reason package_version_missing path="$package_path" upstream="$UPSTREAM_REF"
        actual="$(jq -er '.version // empty' "$package_path")" || fail_reason package_version_missing path="$package_path" current=working_tree
        if [ "$expected" != "$actual" ]; then
            echo "package_version_mismatch path=$package_path expected=$expected actual=$actual upstream=$UPSTREAM_REF" >&2
            exit 1
        fi
        echo "package_contract=checked path=$package_path version=$actual"
    done
    echo 'package_contract=passed'
}

verify_package_publish_capability() {
    [ "${PACKAGE_PUBLISH_REQUIRED:-false}" = true ] || return 0
    package_token="${GH_TOKEN:-}"
    package_token_source=builtin
    if [ "${WORKFLOW_CHANGED:-false}" = true ]; then
        package_token="${WORKFLOW_TOKEN:-}"
        package_token_source=workflow
    fi
    package_login_error="$(mktemp)"
    if ! command -v docker >/dev/null 2>&1 || ! printf '%s' "$package_token" | docker login ghcr.io --username github-actions[bot] --password-stdin >"$package_login_error" 2>&1; then
        cat "$package_login_error" >&2
        fail_reason packages_write_denied
    fi
    echo "package_publish_capability=verified method=ghcr-login token=$package_token_source"
}

capability_preflight() {
    : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
    if [ "${WORKFLOW_CHANGED:-false}" = true ] && [ -z "${WORKFLOW_TOKEN:-}" ]; then
        fail_reason missing_WORKFLOW_TOKEN workflow_files_changed
    fi
    if [ "${WORKFLOW_CHANGED:-false}" = true ]; then
        workflow_token_error="$(mktemp)"
        if ! workflow_actor="$(GH_TOKEN="$WORKFLOW_TOKEN" gh api user --jq .login 2>"$workflow_token_error")" || [ -z "$workflow_actor" ]; then
            cat "$workflow_token_error" >&2
            fail_reason workflow_token_query_error
        fi
        echo "workflow_token=verified actor=$workflow_actor"
    fi
    repo_json_error="$(mktemp)"
    if ! repo_id="$(gh_with_sync_token api "repos/${GITHUB_REPOSITORY}" --jq .id 2>"$repo_json_error")" || [ -z "$repo_id" ]; then
        cat "$repo_json_error" >&2
        fail_reason repository_query_error
    fi
    if ! gh_with_sync_token api "repos/${GITHUB_REPOSITORY}/releases?per_page=1" >/dev/null 2>&1; then
        fail_reason release_query_error
    fi
    verify_package_publish_capability
    dry_run_log="$(mktemp)"
    preflight_ref="refs/heads/singbox-capability-preflight-${GITHUB_RUN_ID:-local}"
    dry_run_attempt=1
    dry_run_ok=false
    while [ "$dry_run_attempt" -le 3 ]; do
        if git_cmd push --dry-run origin "HEAD:$preflight_ref" >"$dry_run_log" 2>&1; then
            dry_run_ok=true
            break
        fi
        cat "$dry_run_log" >&2
        if [ "$dry_run_attempt" -lt 3 ]; then sleep 5; fi
        dry_run_attempt=$((dry_run_attempt + 1))
    done
    if [ "$dry_run_ok" != true ]; then
        fail_reason contents_write_dry_run_denied attempts=$((dry_run_attempt - 1))
    fi
    echo "capability_preflight=passed repository_id=$repo_id contents=write release=read workflow_changed=${WORKFLOW_CHANGED:-false}"
}

case "${1:-}" in
    resolve) resolve_release ;;
    merge) merge_upstream ;;
    package) package_contract ;;
    preflight) capability_preflight ;;
    *) echo 'usage: upstream-sync-lib.sh {resolve|merge|package|preflight}' >&2; exit 2 ;;
esac

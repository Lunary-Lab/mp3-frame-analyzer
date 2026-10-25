#!/usr/bin/env bash
# Print a sanitized, read-only snapshot of the repository's GitHub settings as
# JSON: values for settings, names only for secrets and variables. Endpoints
# the plan or token cannot read are recorded with their HTTP status and
# message, never as absent. Organization-level settings and people inventories are not
# recorded: this snapshot is committed to a public repository.
#   governance/snapshot.sh > /tmp/settings.json
set -euo pipefail
owner=Lunary-Lab
repo=mp3-frame-analyzer
r="repos/$owner/$repo"

if ! gh api "$r" --silent; then
  echo "Cannot read $owner/$repo: check the token in GH_TOKEN" >&2
  exit 1
fi

read_endpoint() { # label endpoint [jq filter] [collection key, or . for an array]
  local response status body pages
  response=$(gh api -i "$2" 2>/dev/null) || true
  read -r _ status _ <<<"$response"
  body=$(sed '1,/^\r\{0,1\}$/d' <<<"$response")
  if [[ "$status" =~ ^2 ]]; then
    [ -n "$body" ] || body=null
    if [ "$#" -ge 4 ]; then
      # The status-bearing probe preserves unavailable endpoints. A successful
      # collection is then read in full; incomplete pagination must fail closed.
      if ! pages=$(gh api --paginate --slurp "$2" 2>/dev/null); then
        echo "Could not read every page of $1" >&2
        return 1
      fi
      body=$(jq -ce --arg key "$4" '
        if type != "array" or length == 0 then error("Missing collection pages")
        elif $key == "." then
          if all(.[]; type == "array") then add
          else error("Expected array pages") end
        elif all(.[]; type == "object" and (.[$key] | type == "array")) then
          {($key): (map(.[$key]) | add)}
        else error("Expected wrapped collection pages") end
      ' <<<"$pages") || return 1
    fi
    jq -n --arg label "$1" --argjson status "$status" --argjson value "$(jq "${3:-.}" <<<"$body")" \
      '{($label): {status: $status, value: $value}}'
  else
    jq -n --arg label "$1" --argjson status "${status:-0}" --arg message "$(jq -r '.message // empty' <<<"$body" 2>/dev/null)" \
      '{($label): {status: $status, unavailable: $message}}'
  fi
}

{
  read_endpoint repository "$r" '{visibility, default_branch, archived, is_template, allow_forking, has_issues, has_projects, has_wiki, has_discussions, allow_squash_merge, allow_merge_commit, allow_rebase_merge, allow_auto_merge, allow_update_branch, delete_branch_on_merge, squash_merge_commit_title, squash_merge_commit_message, merge_commit_title, merge_commit_message, web_commit_signoff_required, description, homepage, topics, security_and_analysis}'
  read_endpoint rulesets "$r/rulesets" 'sort_by(.id)' .
  read_endpoint branch_protection_main "$r/branches/main/protection"
  read_endpoint environments "$r/environments" '[.environments[] | {name, protection_rules, deployment_branch_policy, can_admins_bypass}] | sort_by(.name)' environments
  read_endpoint actions_permissions "$r/actions/permissions" 'del(.selected_actions_url)'
  read_endpoint actions_selected "$r/actions/permissions/selected-actions"
  read_endpoint actions_workflow_token "$r/actions/permissions/workflow"
  read_endpoint actions_access_level "$r/actions/permissions/access"
  read_endpoint actions_fork_pr_approval "$r/actions/permissions/fork-pr-contributor-approval"
  read_endpoint actions_retention "$r/actions/permissions/artifact-and-log-retention"
  read_endpoint actions_oidc_subject "$r/actions/oidc/customization/sub" '{use_default}'
  read_endpoint vulnerability_alerts "$r/vulnerability-alerts" '"enabled"'
  read_endpoint dependabot_security_updates "$r/automated-security-fixes"
  read_endpoint immutable_releases "$r/immutable-releases"
  read_endpoint environments_release "$r/environments/release" '{name, can_admins_bypass, protection_rules: [.protection_rules[] | {type, prevent_self_review, reviewers: [.reviewers[]? | {type, login: .reviewer.login}]}], deployment_branch_policy}'
  read_endpoint release_deployment_policies "$r/environments/release/deployment-branch-policies" '[.branch_policies[] | {name, type}] | sort_by(.name, .type)' branch_policies
  read_endpoint rulesets_detail "$r/rulesets?includes_parents=false" '[.[] | {name, target, enforcement}] | sort_by(.name)' .
  # Repository security_and_analysis above reports available feature metadata.
  # Never request secret-scanning alerts or their secret payloads.
  read_endpoint code_scanning_default_setup "$r/code-scanning/default-setup"
  read_endpoint private_vulnerability_reporting "$r/private-vulnerability-reporting"
  read_endpoint actions_secret_names "$r/actions/secrets" '[.secrets[].name] | sort' secrets
  read_endpoint actions_variable_names "$r/actions/variables" '[.variables[].name] | sort' variables
  read_endpoint dependabot_secret_names "$r/dependabot/secrets" '[.secrets[].name] | sort' secrets
  read_endpoint webhooks "$r/hooks" '[.[] | {name, events, active}] | sort' .
  read_endpoint deploy_keys "$r/keys" '[.[] | {title, read_only}] | sort' .
  read_endpoint autolinks "$r/autolinks" 'length' .
  read_endpoint releases "$r/releases?per_page=100" '[.[] | {tag_name, draft, prerelease, immutable}] | sort_by(.tag_name)' .
  read_endpoint tags "$r/git/matching-refs/tags/" '[.[] | {ref, type: .object.type, sha: .object.sha}] | sort_by(.ref)' .
} | jq -s -S --arg repository "$owner/$repo" --arg captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{repository: $repository, captured_at: $captured_at, settings: add}'

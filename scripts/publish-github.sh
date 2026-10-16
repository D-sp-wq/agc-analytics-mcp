#!/usr/bin/env bash
#
# One-command publish of agc-analytics-mcp to GitHub (bash / macOS / Linux).
#
#   GITHUB_TOKEN=ghp_... ./scripts/publish-github.sh my-github-name
#   ./scripts/publish-github.sh my-github-name            # prepares, prints push steps
#
# Runs the tests and the secret scan first; refuses to publish on failure.

set -euo pipefail

REPO_NAME="${REPO_NAME:-agc-analytics-mcp}"
DESCRIPTION="Huawei AppGallery Connect analytics MCP server — report trends, crash metrics, review insights, daily/weekly digests. Zero dependencies, read-only."
VISIBILITY="${VISIBILITY:-public}"
GITHUB_USER="${1:-${GITHUB_USER:-}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\n=== %s ===\n' "$1"; }
fail() { printf '\n[FAIL] %s\n' "$1" >&2; exit 1; }

if [ "${SKIP_CHECKS:-0}" != "1" ]; then
  step 'Running tests'
  node scripts/run-tests.mjs || fail 'Tests failed — not publishing.'

  step 'Scanning for committed secrets'
  node scripts/check-secrets.mjs || fail 'Secret scan failed — not publishing.'
fi

if [ -z "$GITHUB_USER" ]; then
  read -r -p 'GitHub username: ' GITHUB_USER
fi
[ -n "$GITHUB_USER" ] || fail 'GitHub username is required.'
REPO_URL="https://github.com/$GITHUB_USER/$REPO_NAME"

step "Pointing package metadata at $REPO_URL"
node -e "
const fs = require('fs');
const j = JSON.parse(fs.readFileSync('package.json', 'utf8'));
j.author = process.argv[1];
j.repository = { type: 'git', url: 'git+$REPO_URL.git' };
j.homepage = '$REPO_URL#readme';
j.bugs = { url: '$REPO_URL/issues' };
fs.writeFileSync('package.json', JSON.stringify(j, null, 2) + '\n');
console.log('package.json updated');
" "$GITHUB_USER"
if grep -rl 'YOUR_GITHUB_USERNAME' --include='*.md' . >/dev/null 2>&1; then
  grep -rl 'YOUR_GITHUB_USERNAME' --include='*.md' . | while read -r file; do
    sed -i.bak "s/YOUR_GITHUB_USERNAME/$GITHUB_USER/g" "$file" && rm -f "$file.bak"
    echo "  updated $file"
  done
fi

step 'Preparing the git repository'
if [ ! -d .git ]; then
  git init -b main >/dev/null
  echo '  initialized a new repository on branch main'
else
  echo '  existing .git found — reusing it'
fi

git add -A
git -c user.name="$GITHUB_USER" -c user.email="$GITHUB_USER@users.noreply.github.com" \
  commit -m 'feat: agc-analytics-mcp v0.1.0 — AGC analytics MCP server (report trends, crash metrics, review insights, digests)' || echo '  (nothing new to commit)'
git tag -f v0.1.0 >/dev/null

if [ -n "${GITHUB_TOKEN:-}" ]; then
  step 'Publishing to GitHub'
  STATUS=$(curl -s -o /tmp/agc-create-repo.json -w '%{http_code}' \
    -X POST https://api.github.com/user/repos \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: agc-analytics-mcp-publish' \
    -d "{\"name\":\"$REPO_NAME\",\"description\":\"$DESCRIPTION\",\"private\":$([ "$VISIBILITY" = private ] && echo true || echo false)}")
  case "$STATUS" in
    201) echo "  created $REPO_URL" ;;
    422) echo '  repository already exists — pushing into it' ;;
    *)   echo "  repository creation returned HTTP $STATUS (continuing)"; cat /tmp/agc-create-repo.json 2>/dev/null || true ;;
  esac

  git remote remove origin 2>/dev/null || true
  # Single-use credential URL: never written into .git/config permanently.
  git remote add origin "https://x-access-token:$GITHUB_TOKEN@github.com/$GITHUB_USER/$REPO_NAME.git"
  git push -u origin main || fail 'git push failed — check the token scope.'
  git push origin v0.1.0
  git remote set-url origin "$REPO_URL.git"
  git remote -v
else
  step 'Prepared (no push)'
  echo 'GITHUB_TOKEN is not set — nothing was created or pushed.'
  git remote remove origin 2>/dev/null || true
  git remote add origin "$REPO_URL.git"
  echo
  echo 'Finish with your own git credentials:'
  echo '  git push -u origin main --tags'
fi

printf '\nDone. Repository: %s\n' "$REPO_URL"
cat <<EOF

Client configuration:

{
  "mcpServers": {
    "agc": {
      "command": "npx",
      "args": ["--allow-git=all", "-y", "github:$GITHUB_USER/$REPO_NAME"],
      "env": {
        "AGC_CLIENT_FILE": "/absolute/path/to/api-client.json",
        "AGC_SERVICE_ACCOUNT_FILE": "/absolute/path/to/service-account.json",
        "AGC_SITE": "cn"
      }
    }
  }
}
EOF

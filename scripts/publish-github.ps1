<#
.SYNOPSIS
  One-command publish of agc-analytics-mcp to GitHub.

.DESCRIPTION
  Runs the test suite and the secret scan, initializes the repository if needed,
  commits everything, tags v0.1.0, rewrites the repository placeholders in
  package.json/README, then either
    * creates the GitHub repository through the REST API and pushes, when
      GITHUB_TOKEN is set, or
    * prints the exact commands to finish the push with your existing git
      credentials.

.EXAMPLE
  $env:GITHUB_TOKEN = 'ghp_...'      # repo scope is enough
  pwsh -File scripts/publish-github.ps1 -GitHubUser my-name

.EXAMPLE
  pwsh -File scripts/publish-github.ps1 -GitHubUser my-name -Private
#>
[CmdletBinding()]
param(
  [string]$GitHubUser = $env:GITHUB_USER,
  [string]$RepoName = 'agc-analytics-mcp',
  [string]$Description = 'Huawei AppGallery Connect analytics MCP server — report trends, crash metrics, review insights, daily/weekly digests. Zero dependencies, read-only.',
  [switch]$Private,
  [switch]$SkipChecks,
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step([string]$text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Fail([string]$text) { Write-Host "`n[FAIL] $text" -ForegroundColor Red; exit 1 }

if (-not $SkipChecks) {
  Write-Step 'Running tests'
  node --test 'test/**/*.test.js'
  if ($LASTEXITCODE -ne 0) { Fail 'Tests failed — not publishing.' }

  Write-Step 'Scanning for committed secrets'
  node scripts/check-secrets.mjs
  if ($LASTEXITCODE -ne 0) { Fail 'Secret scan failed — not publishing.' }
}

if (-not $GitHubUser) {
  $GitHubUser = (Read-Host 'GitHub username').Trim()
}
if (-not $GitHubUser) { Fail 'GitHub username is required.' }
$repoUrl = "https://github.com/$GitHubUser/$RepoName"

Write-Step "Pointing package metadata at $repoUrl"
node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.author='$GitHubUser';j.repository={type:'git',url:'git+$repoUrl.git'};j.homepage='$repoUrl#readme';j.bugs={url:'$repoUrl/issues'};fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');console.log('package.json updated')"
Get-ChildItem -Recurse -Include *.md -File | ForEach-Object {
  $text = Get-Content $_.FullName -Raw
  if ($text -match 'YOUR_GITHUB_USERNAME') {
    $text = $text -replace 'YOUR_GITHUB_USERNAME', $GitHubUser
    Set-Content -Path $_.FullName -Value $text -NoNewline
    Write-Host "  updated $($_.Name)"
  }
}

Write-Step 'Preparing the git repository'
if (-not (Test-Path (Join-Path $root '.git'))) {
  git init -b main | Out-Null
  Write-Host '  initialized a new repository on branch main'
} else {
  Write-Host '  existing .git found — reusing it'
}

git add -A
git -c user.name="$GitHubUser" -c user.email="$GitHubUser@users.noreply.github.com" commit -m "feat: agc-analytics-mcp v0.1.0 — AGC analytics MCP server (report trends, crash metrics, review insights, digests)" 2>&1 | Write-Host
if ($LASTEXITCODE -ne 0) { Write-Host '  (nothing new to commit, continuing)' }

git tag -f v0.1.0 | Out-Null

if ($NoPush) {
  Write-Host "`nRepository prepared. Push manually with:" -ForegroundColor Yellow
  Write-Host "  git remote add origin $repoUrl.git"
  Write-Host "  git push -u origin main --tags"
  exit 0
}

Write-Step 'Publishing to GitHub'
$existingRemote = (git remote 2>$null | Where-Object { $_ -eq 'origin' })
if ($env:GITHUB_TOKEN) {
  $headers = @{
    Authorization = "Bearer $($env:GITHUB_TOKEN)"
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'agc-analytics-mcp-publish'
  }
  $payload = @{ name = $RepoName; description = $Description; private = [bool]$Private; has_issues = $true; has_wiki = $false } | ConvertTo-Json
  try {
    Invoke-RestMethod -Method Post -Uri 'https://api.github.com/user/repos' -Headers $headers -Body $payload -ContentType 'application/json' | Out-Null
    Write-Host "  created $repoUrl"
  } catch {
    Write-Host "  repository creation returned: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host '  (continuing — it may already exist)'
  }
  if ($existingRemote) { git remote remove origin | Out-Null }
  # The token is used for this one push only and is never written to git config.
  git remote add origin "https://x-access-token:$($env:GITHUB_TOKEN)@github.com/$GitHubUser/$RepoName.git"
  git push -u origin main
  if ($LASTEXITCODE -ne 0) { Fail 'git push failed. Check that the token has repo scope.' }
  git push origin v0.1.0
  # Drop the credential-bearing URL so it is not left in .git/config.
  git remote set-url origin "$repoUrl.git"
  git remote -v | Write-Host
} else {
  Write-Host 'GITHUB_TOKEN is not set — no repository was created and nothing was pushed.' -ForegroundColor Yellow
  if (-not $existingRemote) { git remote add origin "$repoUrl.git" }
  Write-Host "`nFinish with your own git credentials:" -ForegroundColor Yellow
  Write-Host "  git push -u origin main --tags"
}

Write-Host "`nDone. Repository: $repoUrl" -ForegroundColor Green
Write-Host @"

Client configuration:

{
  "mcpServers": {
    "agc": {
      "command": "npx",
      "args": ["-y", "github:$GitHubUser/$RepoName"],
      "env": {
        "AGC_CLIENT_FILE": "/absolute/path/to/api-client.json",
        "AGC_SERVICE_ACCOUNT_FILE": "/absolute/path/to/service-account.json",
        "AGC_SITE": "cn"
      }
    }
  }
}
"@

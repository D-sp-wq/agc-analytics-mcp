<#
.SYNOPSIS
  A paste window for AGC credentials — no JSON file to write by hand.

.DESCRIPTION
  Opens a small window with one big paste box. Copy whatever the AGC console
  gave you (a JSON blob, "client_id: … / client_secret: …" lines, or a Service
  Account *private.json) and click 保存. The window:

    · recognises the format and stores it in %USERPROFILE%\.agc with 0600
    · never prints the secret; the box is cleared after a successful save
    · runs the offline pre-flight and shows the result
    · offers a real read-only smoke test
    · prints the ready-to-paste MCP client configuration

  Everything it does goes through the same Node scripts the CLI uses, so there
  is one implementation of parsing and storage.

.NOTES
  Double-click 粘贴API.cmd in the repository root, or run:
    powershell -NoProfile -ExecutionPolicy Bypass -STA -File scripts\paste-credential.ps1
  Use -NoGui to run the same flow in the console (for headless machines).
#>
[CmdletBinding()]
param(
  [switch]$NoGui,
  [string]$Repo = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Repo)) { $Repo = Split-Path -Parent $PSScriptRoot }
$node = (Get-Command node -ErrorAction SilentlyContinue)
if ($null -eq $node) {
  $message = '没有找到 node。请先安装 Node.js 20 或更高版本：https://nodejs.org'
  if ($NoGui) { Write-Host $message -ForegroundColor Red } else { [System.Windows.Forms.MessageBox]::Show($message, 'agc-analytics-mcp') | Out-Null }
  exit 2
}

function Get-CredentialDir { Join-Path $env:USERPROFILE '.agc' }

function Save-PastedText {
  param([string]$Text, [switch]$Force)

  $dir = Get-CredentialDir
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agc-paste-{0}.txt" -f ([guid]::NewGuid().ToString('N')))
  try {
    # UTF-8 without BOM so the parser sees the exact pasted bytes.
    [System.IO.File]::WriteAllText($tmp, $Text, (New-Object System.Text.UTF8Encoding($false)))
    $args = @((Join-Path $Repo 'scripts\save-credential.mjs'), '--from-text', $tmp, '--out', $dir, '--json')
    if ($Force) { $args += '--force' }
    $raw = & node @args 2>&1 | Out-String
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
  try { return ($raw | ConvertFrom-Json) } catch { return [pscustomobject]@{ ok = $false; message = $raw } }
}

function Invoke-CheckOnly {
  param([string]$EnvName, [string]$Target)
  $envArgs = @{}
  $envArgs[$EnvName] = $Target
  $previous = [Environment]::GetEnvironmentVariable($EnvName, 'Process')
  try {
    [Environment]::SetEnvironmentVariable($EnvName, $Target, 'Process')
    return (& node (Join-Path $Repo 'scripts\live-smoke.mjs') --check-only 2>&1 | Out-String)
  } finally {
    [Environment]::SetEnvironmentVariable($EnvName, $previous, 'Process')
  }
}

function Invoke-LiveSmoke {
  param([string]$EnvName, [string]$Target)
  $previous = [Environment]::GetEnvironmentVariable($EnvName, 'Process')
  try {
    [Environment]::SetEnvironmentVariable($EnvName, $Target, 'Process')
    return (& node (Join-Path $Repo 'scripts\live-smoke.mjs') --json 2>&1 | Out-String)
  } finally {
    [Environment]::SetEnvironmentVariable($EnvName, $previous, 'Process')
  }
}

function Get-ClientConfig {
  param([string]$EnvName, [string]$Target)
  $entry = (Join-Path $Repo 'index.js').Replace('\', '/')
  $env = [ordered]@{}
  $env[$EnvName] = $Target
  $env['AGC_SITE'] = 'cn'
  [pscustomobject]@{
    mcpServers = [pscustomobject]@{
      agc = [pscustomobject]@{
        command = 'node'
        args    = @($entry)
        env     = [pscustomobject]$env
      }
    }
  } | ConvertTo-Json -Depth 6
}

# ── console fallback ─────────────────────────────────────────────────────────

if ($NoGui) {
  Write-Host '把从 AGC 控制台复制的内容粘贴进来，然后输入一个单独的点号 . 结束：' -ForegroundColor Cyan
  $lines = @()
  while ($true) {
    $line = Read-Host
    if ($line -eq '.') { break }
    $lines += $line
  }
  $result = Save-PastedText -Text ($lines -join "`n")
  if (-not $result.ok) {
    # Windows PowerShell 5.1 has no ?? operator; keep this 5.1-compatible.
    $detail = if ($result.message) { $result.message } else { ($result.problems -join '; ') }
    Write-Host $detail -ForegroundColor Red
    exit 2
  }
  Write-Host $result.message -ForegroundColor Green
  $envName = if ($result.kind -eq 'api-client') { 'AGC_CLIENT_FILE' } else { 'AGC_SERVICE_ACCOUNT_FILE' }
  Write-Host (Invoke-CheckOnly -EnvName $envName -Target $result.target)
  exit 0
}

# ── the window ───────────────────────────────────────────────────────────────

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = '粘贴 AGC API 凭据 — agc-analytics-mcp'
$form.Size = New-Object System.Drawing.Size(820, 620)
$form.StartPosition = 'CenterScreen'
$form.MinimumSize = New-Object System.Drawing.Size(700, 520)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "把你在控制台复制的内容整段粘到下面（JSON / client_id 与 client_secret 两行 / 私钥文件全文都可以），然后点「保存并检查」。`n不需要自己创建 .json 文件。"
$hint.Location = New-Object System.Drawing.Point(14, 12)
$hint.Size = New-Object System.Drawing.Size(780, 40)
$form.Controls.Add($hint)

$paste = New-Object System.Windows.Forms.TextBox
$paste.Multiline = $true
$paste.ScrollBars = 'Vertical'
$paste.AcceptsReturn = $true
$paste.Location = New-Object System.Drawing.Point(14, 56)
$paste.Size = New-Object System.Drawing.Size(780, 150)
$paste.Anchor = 'Top,Left,Right'
$form.Controls.Add($paste)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(14, 212)
$status.Size = New-Object System.Drawing.Size(780, 22)
$status.Text = '等待粘贴…'
$status.ForeColor = [System.Drawing.Color]::DimGray
$form.Controls.Add($status)

$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Text = '保存并检查'
$saveButton.Location = New-Object System.Drawing.Point(14, 240)
$saveButton.Size = New-Object System.Drawing.Size(130, 32)
$saveButton.Add_Click({
  $text = $paste.Text
  if ([string]::IsNullOrWhiteSpace($text)) {
    $status.Text = '请先粘贴内容'
    $status.ForeColor = [System.Drawing.Color]::DarkOrange
    return
  }
  $status.Text = '正在识别并保存…'
  $status.ForeColor = [System.Drawing.Color]::DimGray
  [System.Windows.Forms.Application]::DoEvents()

  $result = Save-PastedText -Text $text
  if (-not $result.ok) {
    $detail = if ($result.problems) { ($result.problems -join "`r`n") } else { $result.message }
    $output.Text = "没有保存。`r`n`r`n$detail`r`n`r`n可粘贴的三种格式：`r`n  · 控制台的 JSON（含 client_id / client_secret）`r`n  · 两行：client_id: …  与  client_secret: …`r`n  · Service Account 的 *private.json 全文"
    $status.Text = '认不出这段内容 —— 见下方说明'
    $status.ForeColor = [System.Drawing.Color]::Firebrick
    return
  }

  $envName = if ($result.kind -eq 'api-client') { 'AGC_CLIENT_FILE' } else { 'AGC_SERVICE_ACCOUNT_FILE' }
  $paste.Clear()   # the secret does not stay on screen
  $check = Invoke-CheckOnly -EnvName $envName -Target $result.target
  $config = Get-ClientConfig -EnvName $envName -Target $result.target

  $output.Text = @"
✔ 已保存：$($result.target)
  识别为：$(if ($result.kind -eq 'api-client') { 'API 客户端凭据' } else { 'Service Account 私钥文件' })

本地检查（不联网）：
$check

接进 AI 客户端时，把下面这段的 "agc" 部分放进 mcpServers：

$config
"@
  $status.Text = '已保存并通过本地检查。可继续点「真实验证（只读）」。'
  $status.ForeColor = [System.Drawing.Color]::SeaGreen
  $smokeButton.Enabled = $true
  $smokeButton.Tag = @($envName, $result.target)
})
$form.Controls.Add($saveButton)

$smokeButton = New-Object System.Windows.Forms.Button
$smokeButton.Text = '真实验证（只读）'
$smokeButton.Location = New-Object System.Drawing.Point(152, 240)
$smokeButton.Size = New-Object System.Drawing.Size(140, 32)
$smokeButton.Enabled = $false
$smokeButton.Add_Click({
  $status.Text = '正在访问华为 AGC 接口（只读），请稍候…'
  $status.ForeColor = [System.Drawing.Color]::DimGray
  [System.Windows.Forms.Application]::DoEvents()
  $envName = $smokeButton.Tag[0]
  $target = $smokeButton.Tag[1]
  $raw = Invoke-LiveSmoke -EnvName $envName -Target $target
  try {
    $payload = ($raw.Substring($raw.IndexOf('{')) | ConvertFrom-Json)
    $lines = @()
    foreach ($step in $payload.steps) {
      $mark = if ($step.status -eq 'ok') { '✔' } elseif ($step.status -eq 'warn') { '!' } else { '✘' }
      $lines += "$mark $($step.name)$(if ($step.detail) { " — $($step.detail)" })"
    }
    $summary = if ($payload.ok) { '核心链路可用 ✔' } else { '有核心步骤失败，请把这段发给维护者' }
    $output.Text = ($lines -join "`r`n") + "`r`n`r`n$summary"
    $status.Text = $summary
    $status.ForeColor = if ($payload.ok) { [System.Drawing.Color]::SeaGreen } else { [System.Drawing.Color]::Firebrick }
  } catch {
    $output.Text = $raw
    $status.Text = '验证输出无法解析，见下方原文'
    $status.ForeColor = [System.Drawing.Color]::Firebrick
  }
})
$form.Controls.Add($smokeButton)

$copyButton = New-Object System.Windows.Forms.Button
$copyButton.Text = '复制结果'
$copyButton.Location = New-Object System.Drawing.Point(300, 240)
$copyButton.Size = New-Object System.Drawing.Size(100, 32)
$copyButton.Add_Click({
  if (-not [string]::IsNullOrWhiteSpace($output.Text)) {
    [System.Windows.Forms.Clipboard]::SetText($output.Text)
    $status.Text = '已复制到剪贴板'
    $status.ForeColor = [System.Drawing.Color]::DimGray
  }
})
$form.Controls.Add($copyButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = '关闭'
$closeButton.Location = New-Object System.Drawing.Point(694, 240)
$closeButton.Size = New-Object System.Drawing.Size(100, 32)
$closeButton.Anchor = 'Top,Right'
$closeButton.Add_Click({ $form.Close() })
$form.Controls.Add($closeButton)

$output = New-Object System.Windows.Forms.TextBox
$output.Multiline = $true
$output.ReadOnly = $true
$output.ScrollBars = 'Both'
$output.WordWrap = $false
$output.Font = New-Object System.Drawing.Font('Consolas', 9)
$output.Location = New-Object System.Drawing.Point(14, 284)
$output.Size = New-Object System.Drawing.Size(780, 280)
$output.Anchor = 'Top,Bottom,Left,Right'
$output.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($output)

$form.Add_Shown({ $paste.Focus() })
[void]$form.ShowDialog()

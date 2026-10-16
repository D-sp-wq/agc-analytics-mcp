<div align="center">

# agc-analytics-mcp

**Huawei AppGallery Connect analytics for any MCP client**

Report trends · Crash metrics · Review insights · Daily/weekly digests

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![deps: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#security--privacy)
[![node](https://img.shields.io/badge/node-%3E%3D20-informational.svg)](https://nodejs.org)

[简体中文](README.md) | English

</div>

---

Plug Huawei AppGallery Connect (AGC) operational data into Claude Code, Cursor, VS Code, Codex CLI,
Gemini CLI, Trae, DevEco Studio CodeGenie, Cherry Studio or any other MCP client, then just ask:

> "How did my HarmonyOS app's new-user trend look over the last 30 days? Any anomaly days?"
> "How much did crashes grow week over week, and on which version?"
> "Cluster the negative reviews from last week."
> "Write yesterday's report."

The server fetches the data from AGC, parses the CSV, runs the trend and week-over-week maths, and
hands the conclusion back to the model.

**This project is read-only.** It never publishes, uploads, replies to reviews or changes AGC state.

---

## What you get

| Capability | Detail |
|---|---|
| **Report trends** | 16 AGC operations reports (HarmonyOS and Android), fetched, CSV-parsed (UTF-8 or GBK), aggregated per day, with WoW change, 7-day moving-average direction, z-score anomaly days, peak/trough and a sparkline |
| **Crash metrics** | APM crash / app-freeze queries and summaries: total, WoW, worst days, top affected versions |
| **Review insights** | Star histogram, average rating, negative-keyword clustering (CJK bigrams + Latin words, zero dependencies), per-version hotspots |
| **Digests** | One call produces a Markdown daily or weekly report; each section degrades independently, and the report can be written to a `.md` file |
| **Zero dependencies, zero build** | Runs straight from GitHub through `npx` — no `npm install`, no compile step, no install scripts |
| **Read-only by construction** | All 13 tools are read-only; the generic passthrough only allows read prefixes, so write operations are unreachable |
| **Credentials stay local** | Read into memory from env vars/files, never written to disk, never logged; authenticated requests can only go to the four Huawei AGC hosts |

---

## Quick start

### 1. Get AGC credentials

In [AppGallery Connect](https://developer.huawei.com/consumer/en/service/josp/agc/index.html) open
「Users and permissions → API keys → Connect API」and create credentials. Both kinds may be configured:

| Credential | How to create | Env var | Notes |
|---|---|---|---|
| **API client** | "API keys" tab → create an API client (**project: N/A**) | `AGC_CLIENT_FILE` (JSON with `client_id`/`client_secret`) or `AGC_CLIENT_ID` + `AGC_CLIENT_SECRET` | All tools; **required** for the review/rating endpoints |
| **Service account** | "Service Account" tab → create, type *developer-level*; a `*private.json` is downloaded | `AGC_SERVICE_ACCOUNT_FILE` | All tools except reviews/ratings |

`AGC_SITE` selects the site: `cn` (default) / `de` / `sg` / `ru`.

Keep credential files outside the repository; `.gitignore` already ignores `.env*` and `*.local.json`.

### 2. Configure your client

```jsonc
{
  "mcpServers": {
    "agc": {
      "command": "npx",
      "args": ["-y", "github:YOUR_GITHUB_USERNAME/agc-analytics-mcp"],
      "env": {
        "AGC_CLIENT_FILE": "/absolute/path/to/api-client.json",
        "AGC_SERVICE_ACCOUNT_FILE": "/absolute/path/to/service-account.json",
        "AGC_SITE": "cn"
      }
    }
  }
}
```

| Client | Where |
|---|---|
| Claude Code | `claude mcp add agc -s user -e AGC_CLIENT_FILE=... -- npx -y github:YOUR_GITHUB_USERNAME/agc-analytics-mcp` |
| Claude Desktop | Windows `%APPDATA%\Claude\claude_desktop_config.json`; macOS `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` |
| VS Code (Copilot Agent) | `.vscode/mcp.json`, key `servers`, add `"type": "stdio"` |
| Codex CLI | `[mcp_servers.agc]` in `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json` |
| Trae / DevEco Studio / Cherry Studio | Paste the JSON above into their MCP settings |

> **Windows**: a few clients cannot spawn `npx` directly — use `"command": "cmd"` with
> `"args": ["/c","npx","-y","github:YOUR_GITHUB_USERNAME/agc-analytics-mcp"]`.

### 3. From source (optional)

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/agc-analytics-mcp.git
cd agc-analytics-mcp
node --test "test/**/*.test.js"   # 55 tests, no network and no credentials needed
node index.js                     # start as a stdio server
```

---

## Tools

All 13 tools are read-only (`readOnlyHint: true`).

| Tool | Purpose |
|---|---|
| `agc_auth_status` | Inspect credential/site configuration (no network) and get fix hints |
| `agc_list_apps` | List projects and their apps (appId / package / device types) |
| `agc_get_app_id` | Package name → appId (comma separated, up to 50) |
| `agc_report_export` | Export one of 16 reports, download and parse it into rows (first 500 by default; `outPath` saves the raw CSV) |
| `agc_report_trend` | Trend analysis for one metric: WoW, 7-day average direction, anomaly days, peak/trough, 28-day sparkline; `metric:""` gives an overview of every numeric column |
| `agc_crash_metric` | Raw crash / app-freeze query normalised to `{day, version, count, users, rate}` |
| `agc_crash_summary` | Crash summary: total, WoW, worst days, top affected versions (**beta**) |
| `agc_ratings_summary` | Ratings (window ≤ 6 months; API-client credential required) |
| `agc_reviews_list` | Review list with rating/version/reply-state/keyword/sort filters and paging |
| `agc_review_insights` | Star histogram, average rating, keyword clusters with examples, version hotspots |
| `agc_daily_report` | Markdown daily digest (defaults to yesterday) |
| `agc_weekly_report` | Weekly digest with an automatic previous-week comparison, optionally saved |
| `agc_request` | Whitelisted read-only passthrough for endpoints without a dedicated tool |

Report windows are capped at **180 days** and review windows at **6 months**; both limits are
validated locally with an actionable message before any request is made.

---

## Examples

Committed sample output lives in docs/examples/ (regenerate with `node scripts/generate-examples.mjs`, no credentials needed): a 30-day report trend with anomaly detection, a daily digest, a weekly digest with real WoW comparisons, and review keyword insights.

```text
agc_auth_status
agc_list_apps
agc_report_trend { appId, report: "harmony-user-analysis", metric: "" }
agc_report_trend { appId, report: "harmony-download", metric: "下载量" }
agc_crash_summary { appId, startDate: "2026-06-01", endDate: "2026-06-07" }
agc_review_insights { appId, platform: "harmonyos", onlyNegative: true, pages: 3 }
agc_weekly_report { appId, endDate: "2026-06-07", outPath: "D:/reports/agc-week.md" }
```

`outPath` never overwrites an existing file unless `overwrite: true` is passed explicitly.

---

## Security & privacy

See [SECURITY.md](SECURITY.md) for the full threat model.

1. **Egress allowlist** — authenticated requests may only reach the four AGC hosts over HTTPS;
   anything else is refused before a connection is opened. Report downloads strip auth headers.
2. **Credentials in memory only** — never persisted, never logged; all diagnostics pass through a
   redactor for `client_secret`, `access_token`, `Bearer …` and `private_key`.
3. **Read-only design** — no publish/upload/delete/reply capability; `agc_request` only allows
   read prefixes, with GET enforced on review and app-info paths.
4. **Zero dependencies** — no `dependencies` or `devDependencies`, hence no transitive supply chain
   and no install scripts.
5. **Local data** — all analysis happens on your machine; the only external calls are to Huawei AGC.

---

## Limitations

- **Crash endpoints are beta**: the request body follows community-verified usage. If the gateway
  rejects it, the raw response is returned with a pointer to `agc_request`.
- **Reviews require the API-client credential**; Service-Account-only setups get a clear error and
  everything else keeps working.
- **Report download URLs expire in ~5 minutes**; the tool downloads within the same call.
- **CSV encoding**: strict UTF-8 first, GBK fallback, lossy UTF-8 as a last resort.
- Community project, not affiliated with or endorsed by Huawei. AppGallery Connect and HarmonyOS are
  trademarks of Huawei Technologies Co., Ltd.

## Development

```bash
node --test "test/**/*.test.js"    # 55 tests: unit, protocol e2e and mock full-chain
node scripts/check-secrets.mjs      # pre-commit secret scan
node scripts/live-smoke.mjs         # real-credential smoke test (needs AGC_* env vars; not in CI)
```

CI runs the suite on Windows and Linux with Node 20 and 22.

## License

[MIT](LICENSE)

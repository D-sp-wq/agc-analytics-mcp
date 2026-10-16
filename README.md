<div align="center">

# agc-analytics-mcp

**华为 AppGallery Connect 数据分析 MCP 服务器**

报表趋势解析 · Crash/AppFreeze 指标 · 评论与评分聚合 · 日报周报生成

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![deps: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#安全与隐私)
[![node](https://img.shields.io/badge/node-%3E%3D20-informational.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-stdio-8a2be2.svg)](https://modelcontextprotocol.io)

简体中文 | [English](README_EN.md)

</div>

---

把华为 AppGallery Connect（AGC）的运营数据接进任何支持 MCP 的 AI 客户端——Claude Code、Cursor、VS Code、Codex CLI、Gemini CLI、Trae、DevEco Studio CodeGenie、Cherry Studio 等。装上之后，你可以直接问：

> “我的鸿蒙应用最近 30 天新增用户趋势怎么样？有没有异常日？”
> “上周崩溃数比前一周涨了多少？集中在哪个版本？”
> “把最近一周的差评关键词聚一下类。”
> “出一份昨天的日报。”

服务器会自己去 AGC 拉数据、解析 CSV、做趋势与环比计算，再把结论交给模型。

**本项目只读**：不发布、不上传、不回复评论、不改任何 AGC 配置。

---

## 为什么用它

| 能力 | 说明 |
|---|---|
| **报表趋势解析** | 16 种 AGC 运营报表（HarmonyOS 与 Android 双平台），自动下载 CSV、解析（含 GBK）、按日聚合，给出周环比、7 日均线方向、z-score 异常日、峰值谷值与迷你趋势线 |
| **Crash 指标分析** | APM 崩溃率 / 应用冻屏指标查询与汇总：总量、周环比、最严重日期、受影响版本 Top 5 |
| **评论与评分聚合** | 星级直方图、平均分、差评关键词聚类（中文二元组 + 英文分词，零依赖）、版本热点 |
| **日报 / 周报生成** | 一条调用产出 Markdown 报告，分节独立降级（某个数据源失败不会毁掉整份报告），可落盘为 `.md` |
| **零依赖 · 零构建** | `npx` 直接从 GitHub 运行，无 `npm install`、无编译步骤、无安装脚本 |
| **只读白名单** | 13 个工具全部只读；通用透传工具只放行只读路径前缀，写操作在设计上就不可达 |
| **凭据不出本机** | 凭据只从环境变量/文件读入内存，永不落盘、永不进日志；带鉴权请求只允许发往华为四个 AGC 站点域名 |

---

## 快速开始

### 0. 最省事：双击一个文件，把 API 粘进去

```bash
git clone https://github.com/D-sp-wq/agc-analytics-mcp.git
```

然后双击仓库根目录的 **`粘贴API.cmd`**，会弹出一个窗口：

```
┌─ 粘贴 AGC API 凭据 ─────────────────────────────────┐
│ 把你在控制台复制的内容整段粘到下面，然后点「保存并检查」。  │
│ 不需要自己创建 .json 文件。                            │
│ ┌───────────────────────────────────────────────┐ │
│ │ （在这里 Ctrl+V 粘贴）                          │ │
│ └───────────────────────────────────────────────┘ │
│ [保存并检查] [真实验证（只读）] [复制结果] [关闭]      │
└───────────────────────────────────────────────────┘
```

- **粘什么都能认**：控制台的 JSON、`client_id: … / client_secret: …` 两行、中文标签（客户端ID/密钥）、两行裸值、Service Account 的 `*private.json` 全文
- 保存到 `%USERPROFILE%\.agc\`（仅你可读），**保存后立刻清空粘贴框**，窗口里不会留下密钥
- 自动跑一次**不联网**的本地检查，再给你一个可选的**真实只读验证**按钮
- 最后给出**可直接粘贴进 AI 客户端**的配置（路径已填好）

> 没有图形界面（Linux 服务器 / 远程终端）时，同样的能力在命令行：
> `node scripts/setup.mjs`（交互向导）或 `node scripts/save-credential.mjs --from-text 粘贴内容.txt`

### 0.5 命令行向导（等价的另一条路）

```bash
cd agc-analytics-mcp
node scripts/setup.mjs
```

向导会：检查 Node 版本 → 问你有哪种凭据（API 客户端 / Service Account 文件）→ 用**不回显**的方式录入并保存到 `~/.agc`（权限仅你可读）→ 本地校验 → 问你要不要做一次真实只读验证 → **最后打印一段可直接粘贴进 AI 客户端的配置**（路径已按你的机器填好），并额外给出"不用文件、直接把两个值写进配置"的替代写法。

随时可非交互使用：

```bash
node scripts/setup.mjs --client-id <id> --client-secret <secret>
node scripts/setup.mjs --sa "C:\Users\你\Downloads\xxx-private.json"
node scripts/setup.mjs --print-config-only    # 只看配置，不写任何文件
```

### 1. 拿到 AGC 凭据

> **找不到「API 密钥」入口？** 大概率是打开成了 HarmonyOS 开发者中心（hdc-console）—— Connect API 凭据只在 **AppGallery Connect**（service/josp/agc/index.html）里。对照表与逐条排查见 [docs/WHERE-IS-API-KEY.md](docs/WHERE-IS-API-KEY.md)。
>
> 没有凭据、或不确定该建哪一种？照着 [docs/GETTING-CREDENTIALS.md](docs/GETTING-CREDENTIALS.md) 做一遍即可（含控制台路径、两个 JSON 文件长什么样、权限与常见错误对照表）。

打开 [AppGallery Connect](https://developer.huawei.com/consumer/cn/service/josp/agc/index.html) →「用户与访问 → API 密钥 → Connect API」，创建凭据。两种凭据可以同时配置：

| 凭据 | 创建方式 | 环境变量 | 适用 |
|---|---|---|---|
| **API 客户端** | 「API 密钥」页签 → 创建 API 客户端（**项目选 N/A**），然后 `node scripts/save-credential.mjs` 录入（密钥不回显） | `AGC_CLIENT_FILE`（含 `client_id`/`client_secret` 的 JSON 路径）或 `AGC_CLIENT_ID` + `AGC_CLIENT_SECRET` | 全部工具，**评论/评分接口必须用它** |
| **Service Account** | 「Service Account」页签 → 创建，类型选**开发者级**，会下载 `*private.json` | `AGC_SERVICE_ACCOUNT_FILE`（该 JSON 的路径） | 除评论/评分外的全部工具 |

站点用 `AGC_SITE` 选择：`cn`（默认）/ `de` / `sg` / `ru`。

其它可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGC_TIMEOUT_MS` | `30000` | 单次请求超时（毫秒） |
| `AGC_BASE_URL` | 按站点推导 | 自定义 API 入口，用于企业网关或本地 mock 联调。**必须 https**；只有回环地址（`127.0.0.1` / `localhost`）允许 http，配置不当会回退到官方站点并在 `agc_auth_status` 中提示 |

> 凭据文件请放在仓库之外，不要提交进 Git。`.gitignore` 已忽略 `.env*` 与 `*.local.json`。

### 2. 安装方式（三选一）

| 方式 | 命令 | 适用 |
|---|---|---|
| **A. 克隆即用（最稳，推荐）** | `git clone https://github.com/D-sp-wq/agc-analytics-mcp.git` 然后用 `node <路径>/index.js` 启动 | 任何环境。零依赖、零安装，只需要 Node ≥ 20 |
| **B. npx 直连 GitHub** | `npx --allow-git=all -y github:D-sp-wq/agc-analytics-mcp` | 允许 npm 拉取 git 依赖的环境（见下方提示） |
| **C. npm 包** | 由你自行 `npm publish` 后 `npx -y agc-analytics-mcp` | 想给团队内分发时 |

> **⚠️ npm 12 起默认禁用 git 依赖**：直接 `npx -y github:...` 会报 `EALLOWGIT: Fetching packages of type "git" have been disabled`。
> 两种解法：加 `--allow-git=all`（如上），或者改用方式 A —— 克隆后用 `node` 启动，完全不经过 npm。
> npm 11 及更早版本没有该限制。

### 3. 配置客户端（同一套「命令 + 环境变量」）

方式 A（克隆）的配置 —— `command` 指向克隆下来的 `index.js`：

```jsonc
{
  "mcpServers": {
    "agc": {
      "command": "node",
      "args": ["C:/tools/agc-analytics-mcp/index.js"],
      "env": {
        "AGC_CLIENT_FILE": "/absolute/path/to/api-client.json",
        "AGC_SERVICE_ACCOUNT_FILE": "/absolute/path/to/service-account.json",
        "AGC_SITE": "cn"
      }
    }
  }
}
```

方式 B（npx）的配置 —— 把 `command`/`args` 换成：

```jsonc
      "command": "npx",
      "args": ["--allow-git=all", "-y", "github:D-sp-wq/agc-analytics-mcp"],
```

各客户端的配置文件位置：

| 客户端 | 位置 |
|---|---|
| Claude Code | `claude mcp add agc -s user -- node /绝对路径/agc-analytics-mcp/index.js`（加 `-e AGC_CLIENT_FILE=...`） |
| Claude Desktop | Windows `%APPDATA%\Claude\claude_desktop_config.json`；macOS `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | 全局 `~/.cursor/mcp.json` 或项目内 `.cursor/mcp.json` |
| VS Code (Copilot Agent) | `.vscode/mcp.json`，键名为 `servers`，需加 `"type": "stdio"` |
| Codex CLI | `~/.codex/config.toml` 的 `[mcp_servers.agc]` |
| Gemini CLI | `~/.gemini/settings.json` |
| Trae / DevEco Studio / Cherry Studio | 各自的 MCP 设置面板粘贴上面的 JSON |

> **Windows 提示**：少数客户端无法直接启动 `npx`，把 `"command"` 改成 `"cmd"`，`"args"` 改为 `["/c","npx", ...]`；路径用正斜杠 `C:/tools/...` 最省事。

### 4. 从源码跑测试

```bash
git clone https://github.com/D-sp-wq/agc-analytics-mcp.git
cd agc-analytics-mcp
npm test   # 55 项测试，无需网络与凭据
node index.js                     # 直接以 stdio 方式启动
```

---

## 工具一览

全部 13 个工具均为只读（`readOnlyHint: true`）。

| 工具 | 作用 |
|---|---|
| `agc_auth_status` | 检查凭据与站点配置（不联网），返回已加载的凭据类型与修复建议 |
| `agc_list_apps` | 列出项目与项目下的应用（appId / 包名 / 设备类型） |
| `agc_get_app_id` | 包名 → appId（逗号分隔，最多 50 个） |
| `agc_report_export` | 导出 16 种报表之一，下载并解析为结构化行（默认返回前 500 行，可 `outPath` 落盘全量 CSV） |
| `agc_report_trend` | 对指定指标做趋势分析：周环比、7 日均线方向、异常日、峰值谷值、28 天趋势线；`metric:""` 得到所有数值列的总览 |
| `agc_crash_metric` | Crash / AppFreeze 指标原始查询，归一化为 `{day, version, count, users, rate}` |
| `agc_crash_summary` | Crash 汇总：总量、周环比、最严重日期、受影响版本 Top 5（**beta**：该接口为社区实测，字段以官方文档为准） |
| `agc_ratings_summary` | 评分查询（时间跨度 ≤ 6 个月，需 API 客户端凭据） |
| `agc_reviews_list` | 评论列表，支持评分/版本/答复状态/关键词/排序过滤与分页 |
| `agc_review_insights` | 评论洞察：星级直方图、平均分、关键词聚类（带例句）、版本热点 |
| `agc_daily_report` | 单日 Markdown 日报（默认昨天）：下载安装、Crash、评分快照 |
| `agc_weekly_report` | 周报 + 上周自动对比，可落盘 |
| `agc_request` | 只读白名单透传，覆盖没有专用工具的只读接口 |

### 可用报表（`report` 参数）

| HarmonyOS 5+ | Android / HarmonyOS 4- |
|---|---|
| `harmony-download` 下载安装 | `download` 下载安装 |
| `harmony-install-failed` 安装失败 | `install-failed` 安装失败 |
| `harmony-user-analysis` 用户分析 | `new-and-retention` 新增与留存 |
| `harmony-atomic-distribute` 元服务分发 | `iap` 应用内付费 |
| `harmony-voc` 应用源声 | `paid-download` / `paid-download-detail` 付费下载及明细 |
| | `game-reservation` 预约、`activity-award` 发奖、`coupon` 优惠券 |
| | `atomic-distribute` / `atomic-user` / `atomic-widget` 元服务（旧版） |

报表时间跨度上限 **180 天**；评论接口上限 **6 个月**——两个限制都会在调用前本地校验并给出可执行的修正建议。

---

## 使用示例

```text
# 先确认凭据
agc_auth_status

# 找到 appId
agc_list_apps

# 最近 30 天新增用户趋势 + 异常日
agc_report_trend { appId, report: "harmony-user-analysis", metric: "" }

# 下载安装量周环比
agc_report_trend { appId, report: "harmony-download", metric: "下载量" }

# 上周崩溃总量与版本分布
agc_crash_summary { appId, startDate: "2026-06-01", endDate: "2026-06-07" }

# 差评关键词
agc_review_insights { appId, platform: "harmonyos", onlyNegative: true, pages: 3 }

# 一份周报
agc_weekly_report { appId, endDate: "2026-06-07", outPath: "D:/reports/agc-week.md" }
```

`agc_report_export` 的 `outPath` 默认不覆盖已存在文件，需要覆盖时显式传 `overwrite: true`。

### 真实输出长什么样

仓库里带了一份**可复现**的样例输出（`node scripts/generate-examples.mjs` 用本地 mock 上游重新生成，不需要凭据）：

| 文件 | 内容 |
|---|---|
| [docs/examples/report-trend.json](docs/examples/report-trend.json) | 30 天报表：各指标周环比、趋势方向、峰值/谷值、异常日（发布日激增 z=46.55） |
| [docs/examples/daily-report.md](docs/examples/daily-report.md) | 日报：7 日下载趋势 + 崩馈日均/最差日/版本分布 + 评分与差评关键词 |
| [docs/examples/weekly-report.md](docs/examples/weekly-report.md) | 周报：下载量 ↑+6.4%、崩溃数 ↑+134.6%（自动对比上一周） |
| [docs/examples/review-insights.json](docs/examples/review-insights.json) | 评论洞察：星级直方图、平均分、「闪退」等关键词簇带例句 |

日报片段（节选自 `docs/examples/daily-report.md`）：

```markdown
## Download & install trend (harmony-download, 7 days to 20260530)

- 下载量: 2332 over the last 7 days (daily average 333.1)
- range 2026-05-24 → 2026-05-30 (7 day(s)); latest 310
- direction down (-3.8%/day); peak 360 on 2026-05-25, trough 264 on 2026-05-29
- trend: ███▇▆▁▄

## Crash metrics (crash, 7 days to 20260530)

- crash events: 448 over 7 day(s) (64.0/day)
- worst day: 2026-05-27 with 146
- top versions: 2.3.0 (406), 2.2.1 (42)
```

---

## 安全与隐私

完整威胁模型见 [SECURITY.md](SECURITY.md)。核心保证：

1. **出网白名单**：所有带鉴权的请求只能发往 `connect-api.cloud.huawei.com` / `-dre` / `-dra` / `-drru` 四个主机且必须 HTTPS；其它主机在连接前即被拒绝。报表下载地址会剥离鉴权头并限制大小。
2. **凭据只进内存**：从环境变量或凭据文件读取，不写盘、不缓存到文件、不进入任何日志或错误消息（统一脱敏 `client_secret` / `access_token` / `Bearer` / `private_key`）。
3. **只读设计**：没有发布、上传、删除、回复评论的能力；`agc_request` 只放行只读路径前缀，且评论与 app-info 路径强制 GET。
4. **零依赖**：`package.json` 无 `dependencies` / `devDependencies`，没有供应链风险、没有安装脚本、没有 `postinstall`。
5. **本地数据**：分析全部在本机完成，不上传任何数据到第三方；唯一的外部访问是华为 AGC 官方接口。

---

## 限制与已知问题

- **Crash 接口标记 beta**：`/api/apm/api/v1/hap/query/{crash|app-freeze}/metric` 的请求体字段来自社区实测。若上游拒绝，工具会原样返回响应并提示改用 `agc_request` 调整字段。
- **评论接口只支持 API 客户端凭据**：只用 Service Account 时评论类工具会失败并提示原因，其余工具不受影响。
- **报表下载地址有效期约 5 分钟**：工具在同一次调用内立即下载，无需人工干预。
- **CSV 编码**：优先按严格 UTF-8 解析，失败时回退 GBK；两者都不可用时按 UTF-8 宽松解析。
- **GBK 需要 Node 的完整 ICU**：官方发行版默认包含；若运行时不支持，中文报表可能出现替换字符。
- 本项目为社区项目，与华为公司无关，未获其背书。AppGallery Connect、HarmonyOS 为华为技术有限公司的商标。

---

## 开发

```bash
npm test    # 单元 + 协议 e2e + mock 全链路，55 项
node scripts/check-secrets.mjs      # 提交前密钥扫描
node scripts/handshake-check.mjs    # 真机 stdio 握手自检（CI 同款）
node scripts/live-smoke.mjs         # 真实凭据冒烟（需 AGC_* 环境变量，不属于 CI）
```

### 第一次用真实凭据验证（推荐顺序）

```bash
# 1) 离线预检：不联网，只检查凭据文件是否存在、格式对不对、有没有把
#    Service Account 的 JSON 错填给 AGC_CLIENT_FILE（反之亦然）
AGC_CLIENT_FILE=/绝对路径/api-client.json node scripts/live-smoke.mjs --check-only

# 2) 真实冒烟：默认取最近 7 天，逐段报告成功/失败（只读调用）
AGC_CLIENT_FILE=/绝对路径/api-client.json node scripts/live-smoke.mjs
AGC_SERVICE_ACCOUNT_FILE=/绝对路径/private.json node scripts/live-smoke.mjs 110012345 --days=14
```

退出码：`0` 核心链路可用 / `1` 核心步骤失败 / `2` 凭据缺失或不可用 / `3` 命令行参数有误。
输出里 `!` 是警告（该凭据或站点不支持的段落，核心链路仍然可用），`✘` 才是失败。
`--json` 可输出机器可读结果，便于接入你自己的巡检。

目录结构：

```
index.js              # bin 入口（仅作为进程入口时启动）
src/mcp-server.js     # stdio JSON-RPC 循环（手写 MCP 协议子集，零依赖）
src/client.js         # HTTP 客户端：域名守卫、业务码、401 重试、下载
src/auth.js           # client_credentials 令牌 + Service Account PS256 JWT
src/tools/*.js        # 13 个工具
src/analytics/*.js    # 趋势 / 文本聚类 / Crash 归一化 / 报告组装（纯函数）
test/*.test.js        # 55 项测试
```

提交 PR 前请确保 `node --test`、`node scripts/check-secrets.mjs` 与 `node scripts/handshake-check.mjs` 均通过；CI 会在 Windows 与 Linux、Node 20 与 22 上跑同一套测试。

## 许可

[MIT](LICENSE)

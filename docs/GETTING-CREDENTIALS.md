# 获取 AGC 凭据（从零开始）

本插件只读 AGC 数据，所有请求都带你的凭据直连华为官方接口。本文用最少步骤把你从"没有凭据"带到"跑通冒烟测试"。

> **懒得看文档？** 直接 `node scripts/setup.mjs` —— 一个向导走完全程，最后给你一段可粘贴进 AI 客户端的配置。

> 官方文档（以官网为准，仅供交叉核对）：
> - Connect API 总览：https://developer.huawei.com/consumer/cn/doc/AppGallery-connect-Guides/agcapi-overview-0000001158245083
> - 获取 Token：https://developer.huawei.com/consumer/cn/doc/AppGallery-connect-References/agcapi-obtain_token-0000001158365043
> - Reports API（报表）：https://developer.huawei.com/consumer/cn/doc/AppGallery-connect-References/agcapi-appdownloadexport-0000001158365059

---

## 0. 先选凭据：你需要哪一种？

| 你想用的功能 | API 客户端 | Service Account |
|---|---|---|
| 报表导出与趋势（下载安装、留存、付费…） | ✅ | ✅ |
| 项目/应用列表、appId 查询 | ✅ | ✅ |
| Crash / AppFreeze 指标（beta） | ✅ | ✅ |
| **评论、评分** | ✅ **必须** | ❌ 上游不支持 |

结论：**只创建 API 客户端就能覆盖全部 13 个工具**。若还想要 Service Account（无需换取 access token、用 PS256 JWT 直连），可以两个都配，插件会按接口支持情况自动选用。

---

## 1. 创建 API 客户端（推荐先做这个）

> **⚠️ 先确认你在哪个控制台** —— 这是失败率最高的一步。
> **HarmonyOS 开发者中心**（地址含 `hdc-console`）里**没有** API 密钥入口；Connect API 凭据只在 **AppGallery Connect**（地址含 `service/josp/agc/index.html`）里。
> 找不到入口请看 → [WHERE-IS-API-KEY.md](WHERE-IS-API-KEY.md)（含两个控制台的对照表和逐条排查）。

1. 打开 [AppGallery Connect](https://developer.huawei.com/consumer/cn/service/josp/agc/index.html)，用你的开发者账号登录。
2. 进入 **用户与访问 → API 密钥 → Connect API**。
3. 切到 **API 客户端** 页签 → **创建**。
   - **项目**：选 **N/A**（不绑定单个项目）。绑定到某个具体项目的 API 客户端在调用部分接口时会缺少权限。
   - 名称随意，例如 `agc-analytics-mcp`。
4. 创建后会给出 **client_id** 与 **client_secret**（部分界面只显示一次，请立刻保存）。

**推荐：用脚本录入，密钥不回显、不进 shell 历史、也不进任何聊天记录**

```bash
node scripts/save-credential.mjs
# client_id: （粘贴后回车）
# client_secret (hidden): （粘贴时不显示任何字符）
# → ✔ saved to ~/.agc/api-client.json  client_id=…abcd  client_secret=…wxyz
```

它会把文件写到 `~/.agc/api-client.json` 并把权限收紧到 0600（POSIX），默认拒绝覆盖已存在的文件（需要覆盖时加 `--force`）。也可以用环境变量非交互录入：

```bash
AGC_CLIENT_ID=… AGC_CLIENT_SECRET=… node scripts/save-credential.mjs --out ~/.agc/api-client.json
node scripts/save-credential.mjs --check        # 只检查现有配置，不写文件
```

如果你更愿意手工创建，JSON 长这样（字段名原生识别，也兼容 `clientId`/`clientSecret`）：

```json
{
  "client_id": "你的 client_id",
  "client_secret": "你的 client_secret"
}
```

保存为例如 `C:\Users\<你>\.agc\api-client.json`（Windows）或 `~/.agc/api-client.json`（macOS/Linux）。

---

## 2. 创建 Service Account（可选，但**不依赖 AGC 菜单**，找不到 API 密钥时先走这条）

路线：华为开发者联盟 **API Console** → API服务 → 配置 → 选择项目 → **创建服务帐号密钥文件** → 生成公私钥 → 创建并下载 JSON。

直达：<https://developer.huawei.com/consumer/cn/console/api/credentials>

也可以：AGC → 同一页面切到 **Service Account** 页签 → 创建（类型选**开发者级**）。

1. 同一页面切到 **Service Account** 页签 → **创建**。
2. 类型选 **开发者级**（developer-level），不要选项目级 —— 项目级只能访问单个项目。
3. 创建完成后**自动下载**一个 `*private.json`，内容形如：

```json
{
  "key_id": "…",
  "private_key": "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n",
  "sub_account": "…",
  "token_uri": "https://oauth-login.cloud.huawei.com/oauth2/v3/token"
}
```

用脚本收拢（同时校验字段是否齐全）：
ode scripts/save-credential.mjs --sa ~/Downloads/xxx-private.json；或手工保存为 ~/.agc/service-account.json。**不要**把它填给 `AGC_CLIENT_FILE`（插件会检测并明确提示填反了）。

---

## 3. 存放与权限

- 放进仓库之外的目录（`.gitignore` 已忽略 `.env*` 与 `*.local.json`，但别把凭据放在项目里赌一次手滑）。
- Windows：`icacls "%USERPROFILE%\.agc" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)R"` 只留自己可读。
- macOS/Linux：`chmod 700 ~/.agc && chmod 600 ~/.agc/*.json`。
- 插件本身不会把凭据写入磁盘、日志或工具输出（诊断信息统一脱敏）；它会进内存、发给华为、然后只留一个令牌缓存。

---

## 4. 两步验证

```bash
# ① 离线预检：不联网。查文件是否存在、JSON 是否合法、有没有两种凭据填反
AGC_CLIENT_FILE=/绝对路径/api-client.json node scripts/live-smoke.mjs --check-only

# ② 真实冒烟：只读调用，默认取最近 7 天
AGC_CLIENT_FILE=/绝对路径/api-client.json node scripts/live-smoke.mjs
```

Windows PowerShell 写法：

```powershell
$env:AGC_CLIENT_FILE = "$env:USERPROFILE\.agc\api-client.json"
node scripts/live-smoke.mjs --check-only
node scripts/live-smoke.mjs
```

指定应用与窗口（不传 appId 时自动取列表里的第一个）：

```bash
node scripts/live-smoke.mjs 110012345 --days=14
```

退出码：`0` 核心链路可用 / `1` 核心步骤失败 / `2` 凭据缺失或不可用 / `3` 参数有误。

---

## 5. 怎么读输出（你的情况：应用已上架、有数据）

```
credential pre-flight:
  ✔ AGC_CLIENT_FILE ok (client_id …abcd)

site: cn (https://connect-api.cloud.huawei.com)
window: last 7 day(s)

✔ auth status — apiClient=true serviceAccount=false; site=cn
✔ list apps — 1 project(s), 1 app(s)
    - 110012345  Demo App  com.example.demo
✔ report trend (harmony-download) — 7 day(s); metrics: 下载量, 安装量, 卸载量
✔ crash summary — total=… over … day(s)
✔ ratings summary — keys: …
```

| 标记 | 含义 | 你需要做什么 |
|---|---|---|
| `✔` | 该段成功 | — |
| `!`（warn） | 这一段你的凭据/站点/平台拿不到数据，**核心链路仍然可用** | 按括号里的原因处理，例如评论接口需要 API 客户端凭据、崩馈接口 shape 未识别（beta） |
| `✘`（fail） | 核心步骤失败 | 见下方错误对照表 |

按你的应用情况，预期是：报表段应当返回真实的 7 天指标；崩馈段可能显示 `shape not recognised (beta endpoint)` —— 这是该接口公开字段不完整导致的告警，不影响报表与评论；评论/评分段只有配了 API 客户端才会成功。

---

## 6. 常见错误对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `No AGC credentials configured.` | 三个环境变量都没设 | 设置 `AGC_CLIENT_FILE` 或 `AGC_CLIENT_ID`+`AGC_CLIENT_SECRET` 或 `AGC_SERVICE_ACCOUNT_FILE` |
| `AGC token request failed (HTTP 401)` | client_id / client_secret 不对，或凭据已删除 | 在控制台重新生成并覆盖 JSON |
| 接口返回 `code=204144647` / HTTP 403 | 凭据角色没有该接口的权限，或站点与账号所属站点不一致 | 检查账号在团队/项目下的角色；确认 `AGC_SITE` 与你的账号站点一致（`cn` 默认） |
| 评论类工具失败、其它工具正常 | 评论接口不支持 Service Account | 换成/补上 API 客户端凭据 |
| `report trend … no date column detected` | 该报表在所选窗口内没有数据，或 `groupBy` 不是按日期 | 换窗口/换报表；插件已按窗口过滤，超出窗口的行会被剔除 |
| `EALLOWGIT: Fetching packages of type "git" have been disabled` | npm 12 默认禁用 git 依赖 | 用 `npx --allow-git=all …`，或改为克隆后用 `node` 启动 |
| 报表能导出但打开是乱码 | 你的导出是 GBK 编码 | 插件已自动回退 GBK 解码；若仍异常请提 issue 附样例（**不要**附真实数据） |

---

## 7. 接进你的 AI 客户端

验证通过后，把同一份环境变量交给 MCP 客户端（示例见 [../README.md](../README.md#3-配置客户端同一套命令--环境变量)）：

```jsonc
{
  "mcpServers": {
    "agc": {
      "command": "node",
      "args": ["C:/tools/agc-analytics-mcp/index.js"],
      "env": {
        "AGC_CLIENT_FILE": "C:/Users/you/.agc/api-client.json",
        "AGC_SITE": "cn"
      }
    }
  }
}
```

---

## English summary

1. AppGallery Connect → **Users and permissions → API keys → Connect API**.
2. **API client** tab → create one with **project = N/A**; save `{"client_id":"…","client_secret":"…"}`.
   This single credential covers all 13 tools; the review/rating endpoints require it.
3. Optional **Service Account** tab → create a **developer-level** account; it downloads a `*private.json`
   with `key_id` / `private_key` / `sub_account`.
4. Keep the files outside the repository, readable only by you.
5. Verify offline first, then live:
   `AGC_CLIENT_FILE=/abs/path/api-client.json node scripts/live-smoke.mjs --check-only` →
   `… node scripts/live-smoke.mjs`
   Exit codes: 0 ok / 1 core step failed / 2 credentials unusable / 3 bad arguments.
   `!` is a warning for a section your credential cannot serve; only `✘` is a failure.

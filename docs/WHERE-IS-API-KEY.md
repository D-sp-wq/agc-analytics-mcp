# 我找不到「API 密钥」入口

这是失败率最高的一步。华为的凭据入口分散在**三个不同的控制台**里，而**放应用的地方不一定是放凭据的地方**。

## 三个控制台，各放什么

| 控制台 | 地址特征 | 你在这里能做什么 | 有 API 凭据吗 |
|---|---|---|---|
| **HarmonyOS 开发者中心**（HDC） | `…/hdc-console/index.html#/…` | APP ID 列表、开放能力管理、ACL 权限、项目管理、项目套餐/配额、证书与设备 | ❌ **没有** |
| **AppGallery Connect**（AGC） | `…/service/josp/agc/index.html` | 我的项目、上架分发、运营分析、用户与访问 | ✅ API 密钥 → Connect API（API 客户端） |
| **开发者联盟 API Console** | `…/console/api/credentials` | **API服务 → 配置** → 创建**服务帐号密钥文件** | ✅ **服务帐号私钥 JSON** |

### 怎么一眼认出自己在哪个

- 顶部页签是「开发者管理 / 应用管理 / 智能体管理」，左侧「用户与访问」下面是**开发者信息 / 团队账号 / 关联主体 / 沙盒测试账号 / 第三方授权管理 / 协议与声明 / 隐私联系信息** → 你在 **HDC**。这里**没有**凭据入口，别再找了（它的「开放能力管理」是给应用开能力的开关，不是发凭据的）。
- 有「我的项目」「用户与访问 → API 密钥」 → 你在 **AGC**，这里建 **API 客户端**（`client_id` + `client_secret`）。
- 页面标题是「API Console」、有「API服务 → 配置」 → 你在 **API Console**，这里下 **服务帐号密钥文件**（`*private.json`）。

---

## 路线 A：服务帐号私钥文件（推荐先做，不依赖 AGC 菜单）

1. 打开 <https://developer.huawei.com/consumer/cn/console/api/credentials>
2. 进入 **API服务 → 配置**
3. 选择你的鸿蒙应用所属的**项目**
4. 点击 **创建服务帐号密钥文件**
5. 点击 **生成公私钥**：公钥上传，**私钥自己保存**
6. 填名称与描述 → **创建并下载 JSON**（文件下载到本地）
7. 那个 JSON 就是本插件要的（字段：`key_id` / `private_key` / `sub_account`）

交给插件：

```bash
node scripts/setup.mjs --sa "C:\Users\你\Downloads\下载下来的那个-private.json"
```

它覆盖除「评论/评分」外的全部工具（报表趋势、Crash 指标、日报周报都能用）。

> 顺带可以拿到应用的 **Client ID**：AGC → `我的项目` → 选项目 → **项目设置** → 下拉到「应用」区域。

---

## 路线 B：API 客户端（评论/评分必须要它）

1. 打开 AGC：<https://developer.huawei.com/consumer/cn/service/josp/agc/index.html>
2. 左侧 **用户与访问 → API 密钥**
3. 若有 **Connect API** 分区 → **API 客户端** 页签 → 创建（**项目选 N/A**）→ 得到 `client_id` + `client_secret`
4. 交给插件：

```bash
node scripts/setup.mjs --client-id <id> --client-secret <secret>
```

官方文档（以官网为准）：
- 获取服务端授权：<https://developer.huawei.com/consumer/cn/doc/App/agc-help-connect-api-obtain-server-auth-0000002271134661>
- 创建 API 客户端：<https://developer.huawei.com/consumer/cn/doc/appgallery-connect-Guides/creating-api-client-0000001738812141>

---

## 情况：你的账号是完全合并版（所有链接都回到 hdc-console）

有些账号（尤其是较新的 HarmonyOS 个人开发者账号）已经把 AGC 合并进 HarmonyOS 开发者中心：打开 `service/josp/agc/index.html` 或 `console/api/credentials` 都会被带回 `hdc-console`。此时左侧菜单里**确实没有**「API 密钥」，凭据入口在别处。

下面是**按可能性排序的点击顺序**（此节尚需在你的账号上确认，点开哪一个看到相关字样就告诉我）：

| 顺序 | 点哪里 | 找什么字样 |
|---|---|---|
| 1 | 应用行右侧的 **「开发」** 按钮 | 项目设置 / API 密钥 / 客户端 ID / agconnect-services.json / 应用信息 |
| 2 | 顶部页签 **「应用管理」** | 应用级设置、开放能力、API 配置 |
| 3 | 应用行右侧的 **「分发」** | 上架配置里可能带 API/服务帐号入口 |
| 4 | 右上角 **头像菜单** | 我的控制台 / 开发者联盟 / AppGallery Connect / 账号中心 |
| 5 | 顶部 **「智能体管理」** | 一般无关，但改版时新入口会出现在这里 |

如果 1 或 2 里出现「**API 密钥**」「**服务帐号**」「**客户端 ID**」「**项目设置**」这类字样，凭据就在那儿；截图发我，我按图给出下一步。

> 已经在 hdc-console 里、左侧菜单和这个表都对不上？那就把**点开「开发」后的页面**截一张图 —— 这是应用级配置最可能的落点。

## 还是没有？逐条排查

| 可能原因 | 怎么确认 / 怎么办 |
|---|---|
| 在 HDC 里找凭据 | 见上一节「合并版账号」；HDC 的「开放能力管理」是给应用开能力的开关，不发凭据 |
| AGC 的「用户与访问」下没有「API 密钥」 | 这个账号在 AGC 侧没有该入口 → 走**路线 A**（API Console 的服务帐号），它不依赖该菜单 |
| 账号不是团队创建者/管理员 | 「用户与访问 → 团队账号」看角色；API 密钥通常只有创建者/管理员能看 |
| 未完成开发者实名认证 | 「用户与访问 → 开发者信息」看认证状态（显示「已认证」就没问题） |
| 还没有 AGC 项目 | AGC 首页「我的项目 → 创建项目」，再回来 |
| 页面改版 / 菜单改名 | 以功能为准：找「API」「密钥」「凭据」「服务帐号」这些字样，别死记菜单名 |
| 浏览器缓存旧页面 | 退出重登，或用无痕窗口；注意**不要**在已经打开的旧标签里点链接 |

## 还是不行？

把**你点开的那个页面**截图发出来（就像你发现 HDC 里没有 API 密钥那样），我按图告诉你下一步点哪里 —— 这比读文档有效。

## 自检工具

拿到任何凭据文件后，先跑不联网的校验，能立刻分清"入口找错了"还是"文件填错了"：

```bash
node scripts/live-smoke.mjs --check-only
```

---

## 信息来源

- 三控制台分工与路线 A 的操作步骤：与 DCloud 官方文档 [uni-push 鸿蒙厂商推送专题](https://doc.dcloud.net.cn/uniCloud/uni-cloud-push/harmony.html)（2025-08 更新）中"创建服务帐号密钥文件""获取 Client ID"两节一致
- 路线 B：AppGallery Connect 官方文档"获取服务端授权""创建 API 客户端"（链接见上）
- HDC 菜单构成：以你自己账号的截图为准（`hdc-console`，含 沙盒测试账号 等条目）

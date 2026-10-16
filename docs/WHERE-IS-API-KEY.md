# 我找不到「API 密钥」入口

这是最常见的第一个坎。**先确认你在哪个控制台** —— 这两个控制台长得很像，但只有一个有 Connect API 凭据。

## 两个控制台

| | HarmonyOS 开发者中心（HDC） | AppGallery Connect（AGC） |
|---|---|---|
| 地址 | `developer.huawei.com/consumer/cn/hdc-console/index.html#/home/…` | `https://developer.huawei.com/consumer/cn/service/josp/agc/index.html` |
| 顶部页签 | 开发者管理 / 应用管理 / 智能体管理 | 我的项目 / 用户与访问 / … |
| 左侧「用户与访问」下面有什么 | 开发者信息、团队账号、关联主体、沙盒测试账号、第三方授权管理、协议与声明、隐私联系信息 | **API 密钥**（展开后有 Connect API）、团队成员等 |
| 有 Connect API 凭据吗 | ❌ **没有** | ✅ **有** |

> 如果你的左侧「用户与访问」展开后是「开发者信息 / 团队账号 / 关联主体 / 沙盒测试账号 / 第三方授权管理 / 协议与声明 / 隐私联系信息」，那你就在 HDC —— 请改用上面的 AGC 地址。

## 正确路径

1. 打开 **AGC 控制台**：<https://developer.huawei.com/consumer/cn/service/josp/agc/index.html>
2. 左侧 **用户与访问 → API 密钥**
3. 页面上有 **Connect API** 分区，里面是两个页签：
   - **API 客户端** → 创建（**项目选 N/A**）→ 得到 `client_id` + `client_secret`
   - **Service Account** → 创建（类型选**开发者级**）→ 自动下载 `*private.json`

官方文档（以官网为准）：
- 获取服务端授权：<https://developer.huawei.com/consumer/cn/doc/App/agc-help-connect-api-obtain-server-auth-0000002271134661>
- 创建 API 客户端：<https://developer.huawei.com/consumer/cn/doc/appgallery-connect-Guides/creating-api-client-0000001738812141>

## 在 AGC 里也看不到「API 密钥」？逐条排查

| 可能原因 | 怎么确认 / 怎么办 |
|---|---|
| 打开了 HDC 而不是 AGC | 对照上表；地址栏里应出现 `service/josp/agc/index.html` |
| 账号不是团队创建者/管理员 | 「用户与访问 → 团队账号」看自己的角色；只有创建者/管理员能管理 API 密钥，普通成员看不到该入口 → 找团队管理员要，或让他按本文创建一个给你 |
| 账号还没完成开发者实名认证 | 「用户与访问 → 开发者信息」看认证状态；未认证时部分入口不出现 |
| 账号刚注册、还没有 AGC 项目 | 先建一个项目（AGC 首页「我的项目 → 创建项目」），再回「用户与访问 → API 密钥」 |
| 浏览器缓存/旧页面 | 退出重登一次，或用无痕窗口打开 AGC 地址 |
| 页面改版、菜单改名 | 以上表为准看「用户与访问」下有没有「API 密钥」；没有就按官方文档「获取服务端授权」页里的按钮逐级点进去 |

## 还是不行？

把 **AGC 控制台**（不是 HDC）左侧菜单展开的那张截图发出来，我按图告诉你下一步点哪里 —— 你就是这么发现 HDC 里没有这个入口的。

## 顺带一提：这个仓库的自检能帮你确认凭据是否可用

拿到 `client_id`/`client_secret` 后：

```bash
node scripts/setup.mjs          # 向导：录入 + 本地校验 + 打印可粘贴配置
# 或
AGC_CLIENT_FILE=/绝对路径/api-client.json node scripts/live-smoke.mjs --check-only
```

`--check-only` 不联网，只检查文件是否存在、字段是否齐全、有没有把两种凭据填反 —— 定位"是入口找错了"还是"凭据填错了"很快。

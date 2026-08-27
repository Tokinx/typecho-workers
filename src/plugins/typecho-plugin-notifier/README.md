# typecho-plugin-notifier (Notifier)

多渠道通知插件：**邮件（Resend / MailerSend / Brevo / Plunk / Maileroo）+ WebHook（Bark / Telegram）**。Cloudflare Workers 环境无需 SMTP 服务器，邮件与 WebHook 均通过 HTTP API 发送。

> 2.0 起由 `typecho-plugin-mailer` 升级而来。旧版 Mailer 配置会自动读取迁移（见下文「升级迁移」）。
>
> 2.1 起设置与测试合并为单一后台页 `/admin/plugin/notifier-settings`（无通用插件配置表单；启用插件即视为可发送，无总开关）。
>
> 2.2 起邮件合并为一套「新消息」模板；WebHook 内容改为 JSON 模板。
>
> 2.3 起移除 Bark / Telegram 渠道，仅保留**邮件 + WebHook**。需要手机推送时，把 WebHook 指向 Bark / Telegram 的推送端点即可（见下文「Bark / Telegram 用户迁移」）。

## 功能

- **系统通知** — 注册 `mail:send` filter hook，为核心 `sendMail()`（密码重置邮件等）提供投递：邮件渠道透传核心内容，WebHook 用独立模板推送到管理员端点
- **新评论通知管理员** — 新评论（含**待审核 waiting**、含回帖）通知全部管理员；`spam` 不通知；评论者本人是管理员时跳过自身
- **评论回复通知** — 有人回复评论（仅审核通过后）通知被回复者邮箱
- **模板占位符** — 评论类模板支持 `{site.name}` `{site.url}` `{site.description}` `{post.title}` `{post.url}` `{reply.author}` `{reply.content}` `{reply.mail}` `{reply.avatarUrl}` `{comment.author}` `{comment.content}` `{comment.mail}` `{comment.avatarUrl}`；系统类模板额外支持 `{subject}` `{body}` `{text}` `{reason}` `{to}`。`{reply.*}` 为新评论，`{comment.*}` 为被回复的评论（无被回复评论时为空）；邮件正文自动转义并派生纯文本，WebHook 的 JSON 占位符自动做 JSON 转义
- **统一设置页** — 后台菜单「通知设置」→ `/admin/plugin/notifier-settings`：通知方式矩阵、渠道 Tabs（凭证 + 模板 + 测试发送）

## 配置

入口：插件列表「设置」或后台「设置」→「通知设置」（`/admin/plugin/notifier-settings`）。

| 组 | 字段 | 说明 |
|----|------|------|
| 通知方式 | 系统通知 × 邮件/WebHook | 每个分类 × 渠道一个开关，默认全部关闭，需显式开启。插件已激活即视为可发送（无总开关） |
| 通知方式 | 新评论通知管理员 × 同上 | 含待审核与回帖 |
| 通知方式 | 评论回复通知 × 邮件 | 回复通知仅提供邮件渠道（被回复者通常是游客，只有邮箱可达） |
| 邮件渠道 | 服务商 / API Key / 发件邮箱 / 发件名称 | 五家服务商任选；服务商下拉下方有对应官网链接，方便获取 API Key |
| WebHook 渠道 | 地址 / Token（可选） | Token 附加 `Authorization: Bearer`，payload 由模板渲染 |
| 模板 | 新消息邮件标题/正文（一套模板同时用于管理员评论通知与回复通知） | 系统通知邮件无模板（透传核心内容）；2.1 的「新评论/回复」两套模板键仍会被读取合并 |
| 模板 | 系统/新评论 × WebHook JSON | 系统通知与评论通知各一套独立 JSON 模板 |

保存时校验：勾选了某个渠道但对应凭据不完整会提示具体字段；WebHook 的 JSON 模板必须是合法 JSON（占位符需放在双引号内）。旧配置里若仍存 `enabled: false`，加载时会把所有分类开关视为关闭（行为与旧总开关一致），下次保存后会丢弃该字段。

配置经 `POST /api/admin/plugin-notifier/config` 写入（管理员 + CSRF + 同源校验）；密码字段使用占位符避免覆盖未修改的密钥。

## 测试发送

在「通知设置」各渠道 Tab 内一键测试：

- 邮件需填写测试收件箱；WebHook 一键发送到已保存的端点
- 发送内容使用「新评论」分类的模板与示例数据（邮件为统一的「新消息」模板；请先保存设置）
- 插件通过 `route:request` 路由 `/api/admin/plugin-notifier/test` 发送（管理员认证 + CSRF），未改动系统核心

## 渠道接入要点

| 渠道 | 说明 |
|------|------|
| [Resend](https://resend.com) | `Authorization: Bearer <key>`，API Key 以 `re_` 开头 |
| [MailerSend](https://mailersend.com) | `Authorization: Bearer <key>`，API Key 以 `mlsn.` 开头 |
| [Brevo](https://brevo.com) | `api-key: <key>` 请求头 |
| [Plunk](https://useplunk.com) | `Authorization: Bearer <key>`，API Key 以 `plk_` 开头 |
| [Maileroo](https://maileroo.com) | `X-Api-Key: <key>` 请求头 |
| WebHook | `POST` 用户地址 + 渲染后的 JSON payload（可选 Bearer Token），2xx 判定成功 |

## 升级迁移（Mailer 1.x → Notifier 2.x）

- 在后台重新启用 `Notifier`；旧 `Mailer` 在激活列表中残留的 id 无害，不会显示
- `loadConfig` 找不到新配置键 `plugin:typecho-plugin-notifier` 时会自动回退读取旧的 `plugin:typecho-plugin-mailer`：`provider/apiKey/from/fromName` → 邮件渠道字段，`commentNotifyEnabled/replyNotifyEnabled` → 对应开关，`subject/body` → 统一的「新消息」邮件模板
- 2.1 存的「新评论/回复」邮件模板仍会被读取合并为统一模板
- 系统通知各渠道开关升级后默认关闭，需在设置页显式开启（例如恢复密码重置邮件的发送需勾选「系统通知 · 邮件」）
- 首次保存设置后即写入新配置键；不写库即可完成迁移

## Bark / Telegram 用户迁移（2.2 → 2.3）

2.3 移除了 Bark / Telegram 渠道，但**不需要**插件支持也能继续用手机推送——WebHook 通道会把渲染后的 JSON 原样 POST 到任意地址，Bark 与 Telegram 的 API 恰好都是普通 JSON POST：

- **Bark**：WebHook 地址填 `https://api.day.app/push`（或自部署地址），payload 模板里带上自己的 `device_key`。例如系统通知：

  ```json
  {
    "title": "{site.name} 系统通知：{subject}",
    "body": "{text}",
    "device_key": "你的DeviceKey"
  }
  ```

- **Telegram**：WebHook 地址填 `https://api.telegram.org/bot<你的BOT_TOKEN>/sendMessage`（token 在 URL 路径中），payload 带 `chat_id`：

  ```json
  {
    "chat_id": "-100xxxx",
    "text": "新评论：《{post.title}》\n{reply.author}：{reply.content}"
  }
  ```

注意两点差异：Bark / Telegram 的业务失败通常包装在 HTTP 200 的 JSON 里（`code ≠ 200` / `ok: false`），WebHook 通道只看 HTTP 状态码，这类失败不会报错；另外 token / device key 写进 URL 或模板后会明文回显在设置页（不受密码占位符保护）。

## 与系统邮件设置的关系

- 讨论设置页中的「启用邮件通知 / 发件邮箱 / 发件人名称 / 有新评论时发送邮件通知 / 包含评论回复通知」已移除，全部由本插件配置接管
- 通知收件人为管理员账号邮箱（`typecho_users` 表 `group = 'administrator'`），评论者/发布者本人不会收到自己的通知
- 关闭「系统通知 · 邮件」后密码重置等系统邮件将无法发送

## 模板示例

新消息邮件正文默认模板：

```html
<p>《{post.title}》有新动态：</p>
<p>{reply.author}：</p>
<blockquote>{reply.content}</blockquote>
<p><a href="{post.url}">查看详情</a></p>
```

新评论 WebHook JSON 默认模板：

```json
{
  "event": "comment",
  "site": "{site.name}",
  "post": {
    "title": "{post.title}",
    "url": "{post.url}"
  },
  "author": "{reply.author}",
  "mail": "{reply.mail}",
  "content": "{reply.content}"
}
```

## 开发

```sh
npx vitest run src/plugins/typecho-plugin-notifier/index.test.ts
```
# typecho-plugin-mailer (Mailer)

通过 HTTP API 接入 **Resend / MailerSend / Brevo / Plunk / Maileroo** 等邮件渠道的邮件通知插件。Cloudflare Workers 环境无需 SMTP 服务器，插件直接调用各渠道的 REST API 发送邮件。

## 功能

- **邮件发送适配器** — 注册 `mail:send` filter hook，为核心 `sendMail()`（密码重置邮件等）提供实际投递能力
- **新评论通知管理员** — 收到新评论时向所有管理员邮箱发送通知
- **评论回复通知** — 有人回复评论时通知被回复者
- **模板占位符** — 邮件标题与正文支持 `{site.name}` `{site.url}` `{site.description}` `{post.title}` `{post.url}` `{reply.author}` `{reply.content}` `{reply.mail}` `{reply.avatarUrl}` `{comment.author}` `{comment.content}` `{comment.mail}` `{comment.avatarUrl}`。`{reply.*}` 为新回复评论，`{comment.*}` 为被回复的评论（无被回复评论时为空），用户内容自动转义，纯文本版本自动生成
- **测试发送** — 插件自带测试页面（后台菜单「邮件测试」→ `/admin/plugin/mail-test`），使用已保存的配置发送测试邮件，无需改动系统核心

## 配置

| 字段 | 说明 |
|------|------|
| 启用邮件通知 | 总开关，关闭后插件不发送任何邮件（包括密码重置邮件） |
| 邮件通知渠道 | Resend / MailerSend / Brevo / Plunk / Maileroo |
| API Key | 对应渠道的 API Key |
| 发件邮箱 | 必须在对应渠道验证过的域名邮箱 |
| 发件名称 | 收件人看到的发件人显示名称（如「我的博客」），留空则只显示邮箱 |
| 有新评论时通知管理员 | 开关 |
| 包含评论回复通知 | 开关 |
| 邮件标题 / 邮件正文 | 模板，支持占位符 |

## 测试发送

后台导航「管理」菜单中的「邮件测试」入口，或直接访问 `/admin/plugin/mail-test`：

- 显示当前保存的渠道、发件邮箱与 API Key（掩码）
- 填写测试收件邮箱后点击「发送测试邮件」，插件通过自身的 `route:request` 路由 `/api/admin/plugin-mail/test` 发送（管理员认证 + CSRF 校验）
- 插件仅依赖现有 hooks（`admin:page` / `route:request` / `admin:footer`），未改动系统核心；发送前请先保存插件设置

## 渠道接入要点

| 渠道 | 说明 |
|------|------|
| [Resend](https://resend.com) | `Authorization: Bearer <key>`，API Key 以 `re_` 开头 |
| [MailerSend](https://mailersend.com) | `Authorization: Bearer <key>`，API Key 以 `mlsn.` 开头 |
| [Brevo](https://brevo.com) | `api-key: <key>` 请求头 |
| [Plunk](https://useplunk.com) | `Authorization: Bearer <key>`，API Key 以 `plk_` 开头 |
| [Maileroo](https://maileroo.com) | `X-Api-Key: <key>` 请求头 |

## 与系统邮件设置的关系

- 讨论设置页（选项 → 评论）中的「启用邮件通知 / 发件邮箱 / 发件人名称 / 有新评论时发送邮件通知 / 包含评论回复通知」已移除，全部由本插件的配置接管
- 存量数据库中旧的 `mailEnabled` / `mailFrom` 等选项值不会被读取，可手动清理
- 通知收件人为管理员账号邮箱（`typecho_users` 表中 `group = 'administrator'` 的用户），评论者/发布者本人不会收到自己的通知

## 模板示例

默认正文模板：

```html
<p>{site.name} 有新动态：</p>
<p>文章《{post.title}》{reply.author} 留下了新内容：</p>
<blockquote>{reply.content}</blockquote>
<p><a href="{post.url}">查看详情</a></p>
```

## 开发

```sh
npx vitest run src/plugins/typecho-plugin-mailer/index.test.ts
```

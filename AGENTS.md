# AGENTS.md — OpenSpec SDD

> 面向 AI 编程助手的规格驱动开发（Specification-Driven Development）文档。
> 定义项目架构、编码约定与不可变约束，确保 AI Agent 生成代码的一致性。

---

## 1. 项目标识

| 属性 | 值 |
|------|-----|
| 名称 | Typecho-Workers |
| 描述 | Typecho 博客系统的 TypeScript 重写，运行于 Astro + Cloudflare Workers + D1 |
| 仓库 | `https://github.com/Tokinx/typecho-workers` |
| 许可证 | MIT |
| 包管理器 | bun（锁定） |

---

## 2. 技术栈

| 层 | 技术 | 版本约束 |
|----|------|---------|
| 框架 | Astro (SSR mode) | 7.x |
| 适配器 | @astrojs/cloudflare | 14.x |
| 运行时 | Cloudflare Workers | — |
| 数据库 | Cloudflare D1 (SQLite) | — |
| ORM | Drizzle ORM | 0.45.x |
| 文件存储 | Cloudflare R2 | — |
| 密码哈希 | PBKDF2-SHA256 | 默认 600,000 迭代（可配置 50,000–600,000）+ 16B salt；可选 Pepper |
| 测试 | Vitest | 4.x |
| 语言 | TypeScript | 7.x |

---

## 3. 架构

### 3.1 请求生命周期

```
请求 → src/middleware.ts
        ├─ early-request 外层（Edge Cache / 共享数据缓存，仅公开 GET，跳过 admin/api/静态路径；未审核评论 Cookie 只读）
        ├─ 安装检测（typecho_options 表不存在 → /install）
        ├─ 加载 options + 激活插件 + syncEarlyRequestProviders
        ├─ 分页 URL 重写（/page/N/ → 基础路径 + locals._page）
        ├─ route:request filter（插件自定义路由）
        └─ 固定链接重写（post/page/category pattern → 内置路由）
     → src/lib/context.ts
        ├─ 初始化 DB 连接
        ├─ 加载 options + computeUrls
        ├─ 自动激活插件（首次安装/升级时）
        ├─ 验证 Cookie（__typecho_uid / __typecho_authCode）
        ├─ 生成 CSRF token
        └─ 触发 system:begin hook
     → 路由匹配（.astro 页面 或 .ts API 端点）
     → 布局渲染（Base.astro → Blog.astro 或 Admin.astro）
```

### 3.2 模块依赖图

```
src/middleware.ts       — 请求入口，安装检测，early-request 外层，URL 重写
  ├─ src/lib/early-request.ts — early-request provider 注册表 + 共享数据加载/失效（provider → fallback）
  ├─ src/lib/query-cache.ts   — 查询读模型缓存（provider → fallback）
  ├─ src/lib/isolate-boot.ts  — per-isolate 建表/索引启动检查
  ├─ src/lib/plugin.ts  — 插件注册表 + Hook 事件总线（核心）
  ├─ src/lib/options.ts — 站点配置 CRUD + computeUrls
  ├─ src/lib/cache.ts   — 缓存域定义 + PUBLIC_HTML_HEADER + 失效通知
  └─ src/db/index.ts    — Drizzle DB 实例工厂

src/lib/context.ts      — 请求上下文（DB / options / user / CSRF）
  ├─ src/lib/options.ts — loadOptions / computeUrls
  ├─ src/lib/auth.ts    — PBKDF2 密码哈希 + Session Token + CSRF
  └─ src/lib/plugin.ts  — setActivatedPlugins / doHook

src/lib/plugin.ts       — 插件系统核心（826 行）
  ├─ 插件注册表（Map<id, PluginInfo>）
  ├─ Hook 注册表（Map<HookPoint, HookRegistration[]>）
  ├─ doHook() — call 钩子（副作用，无返回值）
  ├─ applyFilter() — filter 钩子（链式变换，抛异常中断）
  ├─ applyFilterSafely() — filter 钩子（吞异常，展示用）
  └─ HookPoints 常量 — 69 个挂载点定义

src/lib/theme.ts        — 主题系统
src/integrations/theme-loader.ts   — 构建时发现主题包 → 虚拟模块
src/integrations/plugin-loader.ts  — 构建时发现插件包 → 注入注册表
src/lib/schema-sql.ts   — 运行时从 Drizzle schema 反射生成建表 SQL
src/lib/http.ts        — 标准化 HTTP 错误/成功响应（textError / jsonError / jsonOk）
src/lib/constants.ts   — 跨模块常量（密码最小长度、slug 后缀上限、上传限速、缓存 TTL 等）
```

---

## 4. 数据库

### 4.1 表结构（10 张表；7 张核心表与 PHP Typecho 兼容）

| 表名 | 用途 | 主键 |
|------|------|------|
| `typecho_users` | 用户（5 种角色） | uid (autoinc) |
| `typecho_contents` | 内容（文章/页面/草稿/附件） | cid (autoinc) |
| `typecho_comments` | 评论 | coid (autoinc) |
| `typecho_metas` | 元数据（分类/标签） | mid (autoinc) |
| `typecho_relationships` | 内容-元数据关联 | (cid, mid) |
| `typecho_options` | 站点配置（KV 结构） | (name, user) |
| `typecho_fields` | 扩展字段 | (cid, name) |
| `typecho_login_failures` | 登录限速（D1 持久化） | ip |
| `typecho_password_reset_requests` | 密码重置请求（限速 + 一次性令牌哈希） | email |
| `typecho_db_cache` | Edge Cache L3 数据缓存（D1-backed KV） | cacheKey |

**不可变约束**：
- 表名必须保持 `typecho_*` 前缀，**不可重命名**
- 列名必须与 PHP Typecho 保持一致
- Schema 定义在 `src/db/schema.ts`，修改后必须运行 `bun run db:generate`
- **禁止手动修改 `drizzle/` 目录下的迁移文件**
- 建表 SQL 由 `src/lib/schema-sql.ts` 在运行时从 Drizzle schema 反射生成（`generateCreateSQL()` 同时输出 CREATE TABLE 与 CREATE INDEX；中间件首次命中时会在后台幂等地补齐生产库索引）
- D1 不支持真实事务；批量改写应使用 `db.batch([...])` 单次往返
- 评论的「能否审核」必须查 `contents.authorId`，禁止以 `comments.ownerId` 作为权限判定来源（ownerId 仅是历史快照，G7-4）

### 4.2 关键枚举

```typescript
// contents.type
'post' | 'page' | 'post_draft' | 'page_draft' | 'attachment'

// contents.status
'publish' | 'draft' | 'hidden' | 'private' | 'waiting'

// comments.status
'approved' | 'waiting' | 'spam'

// users.group（数字越小权限越高）
'administrator'(0) | 'editor'(1) | 'contributor'(2) | 'subscriber'(3) | 'visitor'(4)
```

### 4.3 插件配置存储

- 存储在 `typecho_options` 表：`name = "plugin:<pluginId>"`，值为 JSON 字符串
- 通过 `loadPluginConfig(options, pluginId)` 读取（自动合并 manifest 默认值）
- 启用插件时自动写入默认配置，禁用时删除配置
- `typecho_options.secret` 是签名密钥，跨部署必须保留，**不可重置**

---

## 5. Cloudflare 绑定

| Binding | 类型 | 用途 |
|---------|------|------|
| `DB` | D1 | 数据库 `typecho-db` |
| `BUCKET` | R2 | 文件存储 `typecho-uploads` |
| `TYPECHO_CACHE` | KV | 可选；启用 Edge Cache 插件时的 L2 缓存 |

### 5.1 环境变量访问

```typescript
// ✅ 唯一正确方式
import { env } from 'cloudflare:workers';
const db = env.DB;
const bucket = env.BUCKET;

// ❌ 已废弃（Astro 6 + @astrojs/cloudflare v13+ 不支持）
// Astro.locals.runtime.env.DB
```

### 5.2 客户端 IP 获取

```typescript
// ✅ 统一使用
import { getClientIp } from '@/lib/context';
const ip = getClientIp(request);

// ❌ 不要直接读 Header
// 优先级：CF-Connecting-IP > X-Forwarded-For 首个值
```

### 5.3 R2 文件访问

通过 `src/pages/usr/uploads/[...path].ts` 代理访问。

---

## 6. 插件系统

### 6.1 类型

| Hook 类型 | 函数 | 行为 |
|-----------|------|------|
| call | `doHook(point, ...args)` | 执行副作用，无返回值 |
| filter | `applyFilter(point, value, ...args)` | 链式变换，必须返回值，异常传播中断链路 |
| filter-safe | `applyFilterSafely(point, value, ...args)` | 链式变换，吞异常，展示用 |

> 例外：`route:request` 是唯一使用隔离执行的 filter hook——middleware 用 `applyFilterSafely` 调用（P1-2），单个插件 handler 抛异常仅记录并跳过，不整站 500（插件静态打包无法热卸载）；仅 `handled=true` 且带 Response 的结果生效，保留路径硬拦截（G6-4）仍适用。

### 6.2 注册

```typescript
addHook(hookPoint, pluginId, handler, priority = 10)
// priority 越小越先执行
// 同一 (pluginId, hookPoint, handler) 自动去重；重复 addHook 不会触发多次
```

### 6.2.1 懒加载初始化

- 插件 `init()` **不在 build 时直接执行**；`plugin-loader.ts` 通过 `registerPluginLoaders()` 登记字面量动态 import，未激活插件的模块不会在 isolate 启动时求值
- 真正的 `init({ addHook, pluginId })` 由异步的 `setActivatedPlugins(activatedIds)` 在第一次激活时按需触发；调用方必须 `await`，未激活的插件不会注入任何 hook（G6）
- 插件不要在模块顶层做副作用（数据库读写、外部请求、`addHook` 写入），所有注册逻辑必须放在导出的 `init()` 内
- `plugin-loader.ts` 生成的注册代码同时以 `virtual:typecho-plugin-registry` 虚拟模块暴露，并由 `src/middleware.ts` 静态导入；保证冷启动 isolate 的第一次请求（例如直接访问插件路由 `/api/admin/notes`）在 `setActivatedPlugins` 执行前 loader 表已就绪（page-ssr 注入只在页面 chunk 加载后才运行，无法覆盖插件路由）

### 6.3 插件管理路径注册

插件通过 `route:request` hook 处理的 admin/api 路径必须注册，否则中间件的 `isReservedCorePath` 会拦截：

```typescript
import { registerPluginAdminPath } from 'typecho/plugin-sdk';

export default function init({ addHook, pluginId }: PluginInitContext): void {
  // 注册插件的管理路径，使其不被中间件拦截
  registerPluginAdminPath('/api/admin/notes');

  addHook('route:request', pluginId, async (result, extra) => {
    if (extra.path === '/api/admin/notes') { /* ... */ }
    return result;
  });
}
```

- 路径应在插件 `init()` 中注册，在任何 hook handler 之前
- `isPluginAdminPath(path)` 在中间件 `isReservedCorePath` 中调用，白名单通过后放行
- `pluginAdminPaths` Set 是模块级状态，插件停用后同一 isolate 内不自动清退

### 6.4 插件专属管理页面

插件可以在后台渲染完整的单页界面，通过 `admin:page` filter hook 和 `[slug].astro` 路由实现：

```
src/pages/admin/plugin/[slug].astro  — 通用插件页面容器
  → applyFilterSafely('admin:page', '', { slug, csrfToken, ... })
  → 插件注册 admin:page hook，匹配 slug 后返回 HTML
  → HTML 通过 set:html 注入（插件负责自行转义用户数据）
```

Notes 插件的笔记管理页是完整参考实现：`admin:page` 返回包含 CRUD UI 的 HTML + 内联 JS，`admin:footer` 注入导航菜单项。

**关键规则**：
- `admin:page` 是 `[slug].astro` 使用的 filter 风格注入点，但不属于 `HookPoints` 常量，因此不计入 6.6 的 69 个 Hook 点
- `[slug].astro` 使用 `applyFilterSafely`（不是 `applyFilter`），单个插件异常不会导致整页 500
- 插件通过 `admin:footer` hook 向导航栏注入菜单入口（JSON 注入 + JS DOM 操作）
- 插件返回的 HTML 中所有用户数据必须转义（参考 Notes 中的 `E()` 辅助函数）

### 6.5 插件包约定

- npm 包的 `package.json` 的 `keywords` 必须同时包含 `"typecho"` 和 `"plugin"`
- 由 `src/integrations/plugin-loader.ts` 在构建时发现并注入
- 本地插件放在 `src/plugins/<name>/`，根 `package.json` 的 `workspaces` 已包含 `src/plugins/*`，依赖使用 `workspace:*`
- 入口优先发现 `index.ts`，其次 `index.js` / `index.mjs` / `plugin.ts` / `plugin.js`

### 6.6 完整 Hook 点（69）

**call 类型**：
`system:begin`, `system:end`, `admin:header`, `admin:footer`, `admin:navBar`, `admin:begin`, `admin:end`, `admin:writePost:option`, `admin:writePost:advanceOption`, `admin:writePost:bottom`, `admin:writePage:option`, `admin:writePage:advanceOption`, `admin:writePage:bottom`, `admin:profile:bottom`, `post:finishPublish`, `post:finishSave`, `post:delete`, `post:finishDelete`, `page:finishPublish`, `page:finishSave`, `page:delete`, `page:finishDelete`, `feedback:finishComment`, `feedback:reply`, `comment:action`, `user:login`, `user:loginSucceed`, `user:loginFail`, `user:logout`, `user:finishRegister`, `upload:beforeUpload`, `upload:upload`, `upload:delete`

**filter 类型**：
`route:request`, `admin:loginHead`, `admin:loginForm`, `admin:managePosts:titleActions`, `archive:select`, `archive:header`, `archive:footer`, `archive:indexHandle`, `archive:singleHandle`, `archive:categoryHandle`, `archive:tagHandle`, `archive:searchHandle`, `archive:handleInit`, `archive:beforeRender`, `archive:afterRender`, `content:filter`, `content:title`, `content:excerpt`, `content:markdown`, `content:content`, `comment:filter`, `comment:content`, `comment:markdown`, `comment:allowContent`, `comment:avatarMap`, `comment:list`, `post:write`, `page:write`, `feedback:comment`, `feed:item`, `feed:generate`, `widget:sidebar`, `user:register`, `plugin:config:beforeSave`, `csp:directives`, `mail:send`

### 6.7 新增 Hook 点步骤

1. 在 `src/lib/plugin.ts` 的 `HookPoints` 中添加常量，命名格式 `component:hookName`
2. 在触发位置调用 `doHook()` 或 `applyFilter()`
3. 更新 `src/pages/admin/plugins.astro` 的 Hook 参考
4. 更新 `src/plugins/README.md` 的 Hook 表格

---

## 7. 主题系统

### 7.1 主题包约定

- npm 包的 `keywords` 必须同时包含 `"typecho"` 和 `"theme"`
- 由 `src/integrations/theme-loader.ts` 在构建时发现
- 构建时自动复制资源到 `public/themes/{id}/`
- 生成虚拟模块 `virtual:theme-templates`（静态 import 所有主题组件）
- 激活主题 ID 存储在 DB 的 `options.theme`

### 7.2 模板组件 Props

| 组件 | Props 接口 | 用途 |
|------|-----------|------|
| `Index.astro` | `ThemeIndexProps` | 首页文章列表 |
| `Post.astro` | `ThemePostProps` | 文章详情 |
| `Page.astro` | `ThemePageProps` | 独立页面 |
| `Archive.astro` | `ThemeArchiveProps` | 归档（分类/标签/作者/搜索） |
| `NotFound.astro` | `ThemeNotFoundProps` | 404 页面 |

无 `components/` 目录的纯 CSS 主题自动回退到默认主题组件。

### 7.3 样式注入

系统自动在 `<head>` 注入 `<link>` 标签（基于 `theme.json` 的 `stylesheets` + `stylesheet`），主题组件不需要自行引入样式。

---

## 8. 认证系统

### 8.1 密码哈希

- 算法：PBKDF2-SHA256
- 默认迭代次数：600,000（G1，2024 年 OWASP 建议）；`PBKDF2_ITERATIONS` 可显式配置并 clamp 到 [50,000, 600,000]
- Salt 长度：16 字节
- 存储格式：`$PBKDF2$iterations$salt$hash`
- 配置 `PASSWORD_PEPPER` 时先用 HMAC-SHA256 预哈希密码，存储格式为 `$PBKDF2P$iterations$salt$hash`
- 位于 `src/lib/auth.ts`
- `passwordHashNeedsRehash(hash)` 检测低于当前迭代数的旧 hash（如旧 100k）；启用 Pepper 后，无 Pepper 的 `$PBKDF2$` 也会标记重哈希；登录命中时机会式重哈希为当前配置

### 8.2 Session Token

- 格式：`uid:sha256(secret+uid:authCode)`
- 存储于 Cookie：`__typecho_uid` 和 `__typecho_authCode`
- 每次请求由 `src/lib/context.ts` 的 `createContext()` 验证
- Cookie 的 `Secure` 标志由 `shouldUseSecureCookie(request)` 决定（HTTPS / `x-forwarded-proto: https` 时设为 true）
- 前台 HTML 与登录态解耦，`__typecho_uid` / `__typecho_authCode` 可命中并写入公共页面缓存；带 `__typecho_unapproved_comment` Cookie 的请求只读，带 `Authorization` 或 `Cache-Control: no-cache/no-store` 的请求绕过缓存

### 8.3 CSRF 保护

- `generateSecurityToken(secret, authCode, uid)` 生成 token，使用 1 小时滑动桶轮换；`validateSecurityToken` 同时接受当前与上一桶 token
- 评论 token 已绑定 `cid`：`generateCommentToken(secret, cid)` / `validateCommentToken(token, secret, cid, refererFallback?)`；旧的 referer 绑定路径仍兼容（用于已缓存页面）
- 管理后台所有表单必须包含 CSRF token（`<input name="_">`）
- 管理 API 端点必须校验 CSRF token；优先级：
  1. `X-CSRF-Token` 请求头（G8-3，AJAX/JSON 客户端推荐）
  2. POST `application/x-www-form-urlencoded` / `multipart/form-data` 中的 `_` 字段
  3. POST `application/json` body 的 `_` 字段
  4. URL 查询串 `?_=...`（保留兼容旧调用，状态变更类操作应避免）
- `requireAdminAction(request, group, { csrf: true })` 在 CSRF 校验之外还会强制 Origin/Referer 同源（`isSameOriginRequest`）；纯读 GET 端点可传 `csrf: false`，但绝不允许 GET 触发副作用
- `safeAdminRedirectUrl(referer, siteUrl, fallback)` 位于 `src/lib/admin-auth.ts`，安全构造管理后台重定向 URL；必须同时满足 `origin` 与 `siteUrl` 一致且路径为 `/admin` 或 `/admin/*`，防止 Open Redirect 与后台动作跳转到前台任意路径
- 评论来源检查和评论提交后的回跳只允许用 `URL.origin` 判定可信来源，禁止使用 `startsWith(siteUrl)` 或仅比较 `host`

### 8.4 登录限速

- `src/lib/login-rate-limit.ts` 提供 D1 持久化的按 IP 登录限流（`typecho_login_failures` 表），跨 isolate/PoP 共享计数
- 由 `options.loginFailBan*` 配置（管理后台「登录设置」可调）：
  - `loginFailBanEnabled`（默认 1）
  - `loginFailBanWindowSeconds`（默认 300）
  - `loginFailBanMaxFailures`（默认 5）
  - `loginFailBanSeconds`（默认 900）
- 上传端点 `src/pages/api/admin/upload.ts` 复用 `trackSlidingWindow` 工具做按用户滑动窗口限流（内存级，仅本 isolate）

### 8.5 安全响应头

中间件 (`src/middleware.ts`) 通过 `applySecurityHeaders()` 在每次中间件托管响应中自动添加以下安全响应头，除非路由处理程序已设置同名 Header；包括普通路由、插件 `route:request` 响应、安装/静态资源早返回路径。缓存命中响应不逐请求执行 `applySecurityHeaders()`——安全头在页面写入缓存时随响应头一并固化（`responseHeadersForStorage` 保留 CSP 等），命中时原样返回：

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`（仅 HTTPS） |
| `Content-Security-Policy` | 宽型默认（允许 `'self'` + 内联样式 / 脚本 + Gravatar 图片 + R2/usr/uploads），另叠加管理员配置的 CSP 白名单（见下） |
| `Permissions-Policy` | 默认禁用 camera/microphone/geolocation/payment/usb |

`csp:directives` filter hook 允许插件追加/调整 CSP directives；插件应只附加来源，不要清空默认 directive。

管理员可在「基本设置」的 `cspWhitelist` 选项按行追加外部域名（每行一个，裸域名自动补 `https://`，`#` 行忽略），由 `parseCspWhitelist()` 解析后增量并入 `script-src`/`style-src`/`img-src`/`connect-src`/`font-src`/`media-src`/`frame-src` 七组指令（`CSP_WHITELIST_DIRECTIVES`），不覆盖默认策略、不影响 `csp:directives` 插件贡献；`frame-ancestors`/`base-uri`/`form-action` 与上传响应（`default-src 'none'; sandbox`）不受白名单影响。

### 8.6 安装窗口

- `src/pages/api/install.ts` 的 install POST 在没有 `INSTALL_TOKEN` 密钥时输出 warning 并保留旧的「首位请求者获胜」语义（兼容现存部署）
- 强烈建议运行 `wrangler secret put INSTALL_TOKEN` 之后再发起首次安装，避免抢注
- 安装表单使用 `<input name="installToken">` 提交，服务端用 `timeSafeEqual` 校验



---

## 9. 设计约定

### 9.1 API 端点

- 公开接口 → `src/pages/api/<name>.ts`
- 管理接口 → `src/pages/api/admin/<name>.ts`（必须经过 `requireAdminAction(request, group)`，默认开启 CSRF + Origin 同源校验）
- 文件格式：`.ts`，直接 `export const POST/PUT/DELETE = ...`，返回 `Response`
- 路由由 Astro 文件系统路由自动生成
- `src/pages/api/admin/meta.ts` 只能写入 `category` / `tag` 两类元数据，禁止接受任意 `type`；删除分类前必须拒绝默认分类与有文章关联的分类（G7-1）
- `src/pages/api/admin/content.ts` 保存文章/页面时必须确保 `contents.slug` 唯一；更新为冲突 slug 时追加当前 `cid` 后缀，不允许把唯一索引错误暴露成 500
- `src/pages/api/install.ts` 的 install handler 必须用 `.returning()` 拿真实自增主键，不准硬编码 `cid:1` / `mid:1`（G7-2）；slug 冲突要走 `resolveSlug` 后缀策略（G7-8）
- 副作用类管理操作禁止响应 GET（`delete-spam` 等），统一走 POST + CSRF
- 公共归档（首页/分类/标签/作者/搜索）必须过滤 `created > now()` 的将来贴（G7-5）
- 评论 / 注册 / 登录 等公共 POST 必须做 Origin 同源校验（参考 `isSameOriginRequest`）
- 搜索关键字先 trim，再截断完整 `%keyword%` LIKE pattern 到 50 UTF-8 bytes；截断后不足 2 字符时短路 `1=0`（G4-5）
- Feed 路由的条数受 `options.feedItems` 控制并 clamp 到 `[5,50]`（G7-7）；description 始终走 excerpt，content:encoded 仅在 `feedFullText` 开启时才输出（G7-6）

### 9.2 管理后台页面

1. `src/pages/admin/<name>.astro` 创建页面，使用 `Admin.astro` 布局
2. 如需配套 API，在 `src/pages/api/admin/` 创建同名 `.ts`

### 9.3 模块级状态

Cloudflare Workers 是单线程单 isolate，以下模块级变量是安全的：
- `src/lib/plugin.ts`：`pluginRegistry`、`hookRegistry`（构建时写入，运行时只读；`pendingPluginInits` 用于懒初始化）
- `src/lib/early-request.ts`：`providerLoaders`、`pendingProviders`、`pendingSharedLoads`（并发去重）、`sharedDataGenerations`（失效防回写）
- `src/lib/cache.ts`：`cachedVersion`、`cachedVersionAt`（cacheVersion 短 TTL 内存 memo）
- `src/lib/isolate-boot.ts`：`databaseReadyPassed`、`tableCheckPassed`、`passwordResetSchemaPassed`、`indexEnsurePassed` 及对应 pending promise
- `src/lib/login-rate-limit.ts`：登录限流（D1 持久化） + 上传限流（`trackSlidingWindow`，内存级滑动窗口）

### 9.4 插件配置表单类型

`package.json` 的 `typecho.plugin.config` 字段支持以下类型：
`text`, `textarea`, `select`, `radio`, `checkbox`, `password`, `hidden`, `repeatable`

**扩展属性**：
- `showWhen` — 条件显示，仅适用于 `repeatable.itemFields`。格式：`{ field: "provider", value: "s3" }`，`value` 可为单值或数组
- `optionsSource` — 动态选项源，仅适用于 `select`。当前支持 `"r2Bindings"`（自动读取 wrangler.toml 中的 R2 binding 名称）
- `itemFields` — 嵌套字段定义，仅适用于 `repeatable`

**boolean 型 select**：当选项值为 `"true"` / `"false"` 时，系统通过 `parseBoolean` 辅助函数转换为实际 boolean 存储。在 `plugin:config:beforeSave` hook 中需显式返回该字段（boolean 值），否则会被过滤丢失。

声明 `config` 后，管理插件列表自动显示「设置」链接。

---

## 10. 测试规范

### 10.1 框架与运行环境

- Vitest 在 Node.js 环境运行
- `tests/__mocks__/cloudflare-workers.ts` 提供 `cloudflare:workers` 模块 stub
- 集成测试通过 `@libsql/client` 创建内存 SQLite 数据库

### 10.2 目录结构

- 单元测试 → `tests/unit/<name>.test.ts`
- API 集成测试 → `tests/integration/<name>.test.ts`
- 插件测试 → `src/plugins/<name>/index.test.ts`（与入口同目录）

### 10.3 集成测试 mock 模式

```typescript
import { createTestDb, type TestDatabase } from '../helpers';
let testDb: TestDatabase;
vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
// 若需 mock cloudflare:workers 变量，必须用 vi.hoisted()
const { mockFn } = vi.hoisted(() => ({ mockFn: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: { DB: null, BUCKET: { delete: mockFn } }, ... }));
```

### 10.4 测试要求

- 新增功能和 bug 修复必须同步添加对应测试用例
- 修改后必须运行 `bun run test` 与 `bunx tsc --noEmit`
- 若集成测试为了隔离端点 mock 了 `requireAdminCSRF`，必须另有单元/集成测试覆盖真实 `requireAdminAction()` / CSRF 失败路径
- 安全修复必须包含负向回归用例（例如跨 origin、协议不一致、前缀匹配伪造、非法 enum/type、路径穿越）
- 每个插件必须包含 `index.test.ts`，覆盖：Hook 注册、守卫分支、正常路径、拒绝路径、边界情况、配置验证

---

## 11. 参考示例

| 示例 | 路径 | 说明 |
|------|------|------|
| 参考插件（基础） | `src/plugins/typecho-plugin-antispam/` | 含完整 package.json、index.ts、index.test.ts，基础 filter hook 示例 |
| 参考插件（高级） | `src/plugins/typecho-plugin-notifier/` | 含 `route:request` 自定义路由（设置保存 + 测试发送）、`admin:page` 统一设置页、`admin:footer` 菜单注入、`mail:send` 适配器与模板占位符渲染 |
| 参考插件（CSP 注入） | `src/plugins/typecho-plugin-turnstile/` | 含 `csp:directives` filter hook 动态追加 CSP 来源、`admin:loginHead`/`admin:loginForm` 注入 Turnstile Widget |
| 参考插件（多渠道通知） | `src/plugins/typecho-plugin-notifier/` | 含 `mail:send` 适配器（邮件/WebHook）、分类 × 渠道开关矩阵、渠道 Tabs 设置页（`admin:page` + `route:request`）、旧版 Mailer 配置自动迁移 |
| 参考主题 | `src/themes/typecho-theme-warm/` | 含完整 theme.json、5 个模板组件 |

---

## 12. 关键文件索引

```
src/
├── middleware.ts                    # 请求入口
├── db/
│   ├── index.ts                     # Drizzle DB 工厂
│   └── schema.ts                    # 10 张表定义
├── lib/
│   ├── plugin.ts                    # 插件系统核心（Hook 总线）
│   ├── theme.ts                     # 主题系统
│   ├── context.ts                   # 请求上下文（复用中间件 bootstrap）
│   ├── client-ip.ts                 # 统一客户端 IP 提取
│   ├── content-visibility.ts        # 公共内容可见性规则
│   ├── permalink-pattern.ts         # 固定链接渲染/匹配统一语法
│   ├── isolate-boot.ts              # per-isolate 建表/索引启动检查
│   ├── auth.ts                      # 密码哈希 + Session + CSRF
│   ├── admin-auth.ts                # 管理后台认证中间件 + 安全重定向
│   ├── options.ts                   # 站点配置 CRUD
│   ├── early-request.ts             # early-request provider 注册表 + 共享数据加载/失效
│   ├── query-cache.ts               # 查询读模型缓存
│   ├── cache.ts                     # 缓存域定义 + PUBLIC_HTML_HEADER + 失效通知
│   ├── schema-sql.ts                # 建表 SQL 反射生成
│   ├── sidebar.ts                   # 侧边栏/导航数据加载
│   ├── theme-props.ts               # 主题 Props 类型定义
│   ├── security-headers.ts          # 安全响应头（CSP、HSTS、X-Frame 等）+ csp:directives filter
│   ├── markdown.ts                  # Markdown 渲染 + HTML 净化
│   ├── http.ts                      # 标准化 HTTP 响应（textError / jsonError / jsonOk）
│   ├── constants.ts                 # 跨模块常量（密码、限速、缓存 TTL）
│   └── url.ts                       # URL 规范化与校验
├── integrations/
│   ├── plugin-loader.ts             # 构建时插件发现
│   └── theme-loader.ts              # 构建时主题发现
├── pages/
│   ├── [slug].astro                 # 文章/页面路由
│   ├── admin/                       # 管理后台页面
│   │   └── plugin/
│   │       └── [slug].astro         # 插件专属管理页面容器（admin:page hook 注入点）
│   └── api/
│       ├── comment.ts               # 前台评论 API
│       └── admin/                   # 管理 API 端点
├── plugins/                         # 内置插件（工作区包）
│   ├── README.md                    # 插件开发完整规范
│   ├── typecho-plugin-antispam/     # 反垃圾评论（参考基础插件）
│   ├── typecho-plugin-cache/        # Edge Cache：L1/L2/L3 + 数据缓存 + CDN 改写
│   ├── typecho-plugin-notifier/     # 多渠道通知（邮件/WebHook + 统一设置页）
│   ├── typecho-plugin-notes/        # 笔记内容类型与时间线
│   ├── typecho-plugin-engine/       # AI 智能引擎（写作辅助 / 摘要 / 搜索范围）
│   └── typecho-plugin-turnstile/    # Cloudflare Turnstile 人机验证
└── themes/                          # 内置主题（工作区包）
    └── README.md                    # 主题开发完整规范
tests/
├── setup.ts                         # 全局测试 setup
├── helpers.ts                       # 测试工具函数 (createTestDb, seedAdmin, makeAuthCookie)
├── __mocks__/cloudflare-workers.ts  # cloudflare:workers stub + caches mock
├── unit/                            # 单元测试 (59 个文件)
└── integration/                     # 集成测试 (37 个文件)
scripts/
├── generate-wrangler-config.ts      # build:cloudflare 前生成被忽略的 wrangler.toml
├── migrate.ts                       # PHP Typecho 数据迁移
├── migrate-wordpress.ts             # WordPress WXR 数据迁移
└── reset-password.ts                # 密码重置工具
```

另：`src/lib` 与 `src/plugins` 下共有 8 个测试文件，全部测试文件数为 104。

## 13. 前端 vendor 库维护

- `public/vendor/pagedown.js` 是 WMD 编辑器（pagedown Typecho 系 fork）的**维护源，保持未压缩**；历史上是单行压缩版，直接在压缩文件上修改易出错且 diff 不可读，故反格式化后提交
- 修改后必须运行 `bun run test tests/unit/pagedown-editor.test.ts`（该测试从文件提取 `doCode` / `doLinkOrImage` 做行为断言），**禁止重新压缩该文件**
- 有意行为差异见文件头部注释：链接/图片为内联 Markdown（`[text](url)` / `![desc](url)`）；多行代码段用 ``` 围栏，单行用单个反引号

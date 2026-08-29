# Edge Cache

Typecho-Workers 的页面缓存（平台层 + L1/L2/L3）与 CDN 地址改写插件。

## 启用平台层（Workers Caching）

`astro.config.mjs` 已配置 `cache: { provider: { name: 'cloudflare', entrypoint: '@astrojs/cloudflare/cache/provider' } }`，
`@astrojs/cloudflare` 会自动生成 `cache: { enabled: true }` 部署配置。命中平台缓存的请求不执行 Worker，
不产生 CPU 计费；失效由插件的 `cache.purge({ tags })` 全局即时完成（每次部署后平台缓存重建，
由 L1/L2/L3 回填）。

## 绑定

创建 KV namespace：

```bash
bunx wrangler kv namespace create TYPECHO_CACHE
```

将返回的 namespace ID 写入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "TYPECHO_CACHE"
id = "<YOUR_KV_NAMESPACE_ID>"
```

Cloudflare Git Builds 使用构建变量 `TYPECHO_KV_NAMESPACE_ID`。缺少 `TYPECHO_CACHE` 绑定时插件保持 fail-open，页面直接回源 Astro/D1，不会启用页面缓存；L3 使用站点已有的 `DB` binding，不需要额外资源。

数据查询缓存可以独立选择 D1 KV，因此仅使用 D1 查询缓存时不需要 `TYPECHO_CACHE` binding。

## 缓存链路

- 平台层：Workers Caching（`astro.config.mjs` 的 `cache.provider` 启用）。命中时 Worker 完全不执行（零 CPU/零 KV 读）；未命中才进入下方应用内缓存
- L1：当前 Cloudflare PoP 的 `caches.default`（部署后平台缓存清空时的预热层）
- L2：`TYPECHO_CACHE` KV namespace
- L3：D1 中的 `typecho_db_cache` Key-Value 表
- 回源：Astro SSR 与业务 D1 查询

只有可安全跨访客共享、无敏感查询参数的 `200 text/html` 响应会写入缓存。可缓存的响应通过 `Cloudflare-CDN-Cache-Control: public, max-age={l1Ttl}` 显式声明平台缓存语义，并带 `Cache-Tag: tc:all, tc:{domain}` 供失效时按标签全局清除；`@astrojs/cloudflare` 会对没有该头的响应自动补 `no-store`，因此 admin、API、预览等路径天然不会被平台缓存。当前前台 HTML 已与登录态解耦，因此带认证 Cookie 的前台请求也可以在冷缓存时写入并复用公共页面；带未审核评论 Cookie 的请求仍只读——miss 时渲染提交者可见页面（含待审评论）但**绝不写入任何缓存层**，响应走 BYPASS（no-store）。请求按 平台层 → L1 → L2 → L3 → Astro/D1 的顺序读取，命中 L3 后会按当前启用的上层 TTL 回填 L1/L2。失效通过推进缓存域代际号（使 L1/L2/L3 旧 key 失效）与 `cache.purge({ tags })`（按域标签清除平台层）同时完成，不会遍历 KV 或主动预热页面；代际号也会使旧的 L3 行失效，无需扫描整张表。单篇内容的发布只推进 `home`/`archive`/`other` 三个域（更新或删除已公开内容会额外推进其详情域），其余详情页的缓存不受影响；批量操作与选项/元数据变更仍推进全局 `all` 域。

插件启用状态是页面缓存的总开关，平台层、L1、L2、L3 仍可分别关闭。L1 默认缓存 7 天，可配置为不缓存、1 小时、12 小时、1 天、3 天、7 天或 30 天；L2 默认缓存 3 天，可配置为不缓存、1 天、3 天或 7 天；L3 默认缓存 6 小时，可配置为不缓存、5 分钟、1 小时、6 小时、12 小时或 1 天。L1 选择不缓存时不会读写边缘 Cache API，也不会输出平台缓存头，命中、未命中、绕过和回源响应统一设为 `Cache-Control: no-store, no-cache, must-revalidate`；L2 或 L3 选择不缓存时分别不会读写对应的 KV 层。L3 的过期行会在后续写入时清理，D1 仍是最终回源。

评论列表由前台 API 实时加载，因此评论创建、审核、撤回和删除不会自动刷新页面缓存。主题在缓存 HTML 中直接输出的评论计数可能延迟更新，可在插件管理页手动刷新对应缓存域。管理页支持三组操作：快捷刷新（前台/后台/全部）、按需刷新（HTML 域与前后台数据缓存组可独立勾选）以及 D1 过期行清理；状态条展示各层 TTL、数据缓存后端与上次手动刷新时间。

## 数据查询缓存

后台只提供两个「数据查询缓存」选择：前台数据与后台数据；每组可选择 Workers KV、D1 KV 或不缓存。前台包含站点选项、导航、侧栏、元数据、评论、笔记、公开归档和公开内容；后台包含仪表盘及后台内容、评论、分类标签、媒体、用户和只读选项列表。查询路径为 L0 isolate（60 秒、最多 500 条）→ 所选远端后端 → 业务 D1；选择不缓存时跳过远端后端，但不影响 L0 isolate。D1 KV 复用 `typecho_db_cache`，但使用独立的 `v2` 查询键前缀，不会与页面 L3 响应混用。旧版逐域配置会继续生效，直到在插件设置页保存一次新配置。

公开数据和后台数据默认在所选远程后端保留 7 天。已经验证的登录用户也会写入所选后端，但 key 仅包含 `uid`、角色与 `authCode` 的 SHA-256 scope，远端不会出现原始身份、认证材料或查询文本；用户维度条目同样保留 7 天。认证材料轮换或角色变化会自动切换 viewer scope，文章、评论、元数据、媒体、用户、选项和笔记等写入操作会推进相关域的 generation，因此正常更新不需要等待 TTL 到期。

自由文本搜索、自动补全、编辑表单、预览、密码保护内容、未审核评论视图、登录/重置、CSRF 和包含真实密钥的插件配置不进入数据查询缓存。站点 `secret` 与 `plugin:*` options 始终逐请求从业务 D1 读取，不会写入 L0、Cache API、KV 或 D1 KV。

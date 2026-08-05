# Edge Cache

Typecho-Workers 的三级页面缓存与 CDN 地址改写插件。

## 绑定

创建 KV namespace：

```bash
pnpm exec wrangler kv namespace create TYPECHO_CACHE
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

- L1：当前 Cloudflare PoP 的 `caches.default`
- L2：`TYPECHO_CACHE` KV namespace
- L3：D1 中的 `typecho_db_cache` Key-Value 表
- 回源：Astro SSR 与业务 D1 查询

只有公开、匿名、无敏感查询参数的 `200 text/html` 响应会写入缓存。请求按 L1 → L2 → L3 → Astro/D1 的顺序读取，命中 L3 后会按当前启用的上层 TTL 回填 L1/L2。后台的手动刷新通过推进缓存域代际号完成，不会遍历 KV 或主动预热页面；代际号也会使旧的 L3 行失效，无需扫描整张表。

插件启用状态是页面缓存的总开关，L1、L2、L3 仍可分别关闭。L1 默认缓存 7 天，可配置为不缓存、1 小时、12 小时、1 天、3 天、7 天或 30 天；L2 默认缓存 3 天，可配置为不缓存、1 天、3 天或 7 天；L3 默认缓存 6 小时，可配置为不缓存、5 分钟、1 小时、6 小时、12 小时或 1 天。L1 选择不缓存时不会读写边缘 Cache API，并将命中、未命中、绕过和回源响应统一设为 `Cache-Control: no-store, no-cache, must-revalidate`；L2 或 L3 选择不缓存时分别不会读写对应的 KV 层。L3 的过期行会在后续写入时清理，D1 仍是最终回源。

评论列表由前台 API 实时加载，因此评论创建、审核、撤回和删除不会自动刷新页面缓存。主题在缓存 HTML 中直接输出的评论计数可能延迟更新，可在插件管理页手动刷新对应缓存域。

## 数据查询缓存

后台只提供两个「数据查询缓存后端」选择：前台数据与后台数据。前台包含站点选项、导航、侧栏、元数据、评论、笔记、公开归档和公开内容；后台包含仪表盘及后台内容、评论、分类标签、媒体、用户和只读选项列表。查询路径为 L0 isolate（60 秒、最多 500 条）→ 所选远端后端 → 业务 D1；D1 KV 复用 `typecho_db_cache`，但使用独立的 `v2` 查询键前缀，不会与页面 L3 响应混用。旧版逐域配置会继续生效，直到在插件设置页保存一次新配置。

公开数据按域缓存：评论 60 秒，导航、侧栏、元数据和笔记 7 天，公开归档和内容元数据 1 天。已经验证的登录用户也会写入所选后端，但 key 仅包含 `uid`、角色与 `authCode` 的 SHA-256 scope，远端不会出现原始身份、认证材料或查询文本；所有用户维度条目固定 60 秒。认证材料轮换或角色变化会自动切换 viewer scope，写入操作仍会推进相关域的 generation。

自由文本搜索、自动补全、编辑表单、预览、密码保护内容、未审核评论视图、登录/重置、CSRF 和包含真实密钥的插件配置不进入数据查询缓存。站点 `secret` 与 `plugin:*` options 始终逐请求从业务 D1 读取，不会写入 L0、Cache API、KV 或 D1 KV。

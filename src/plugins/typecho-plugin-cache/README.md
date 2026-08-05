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

Cloudflare Git Builds 使用构建变量 `TYPECHO_KV_NAMESPACE_ID`。缺少绑定时插件保持 fail-open，页面直接回源 Astro/D1，不会启用页面缓存。

## 缓存链路

- L1：当前 Cloudflare PoP 的 `caches.default`
- L2：`TYPECHO_CACHE` KV namespace
- L3：Astro SSR 与 D1

只有公开、匿名、无敏感查询参数的 `200 text/html` 响应会写入缓存。后台的手动刷新通过推进缓存域代际号完成，不会遍历 KV 或主动预热页面。

插件启用状态是页面缓存的唯一总开关。L1 默认缓存 1 天，可配置为不缓存、1 小时、12 小时、1 天、3 天、7 天或 30 天；L2 默认缓存 7 天，可配置为不缓存、1 天、3 天或 7 天。L1 选择不缓存时不会读写边缘 Cache API，并返回 `Cache-Control: no-store, no-cache, must-revalidate`；L2 选择不缓存时不会读写页面 KV，L1 未命中后直接回源 D1。

评论列表由前台 API 实时加载，因此评论创建、审核、撤回和删除不会自动刷新页面缓存。主题在缓存 HTML 中直接输出的评论计数可能延迟更新，可在插件管理页手动刷新对应缓存域。

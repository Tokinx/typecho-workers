# Edge Cache

Typecho-CF 的三级页面缓存与 CDN 地址改写插件。

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

Cloudflare Git Builds 使用构建变量 `TYPECHO_CF_KV_NAMESPACE_ID`。缺少绑定时插件保持 fail-open，页面直接回源 Astro/D1，不会启用页面缓存。

## 缓存链路

- L1：当前 Cloudflare PoP 的 `caches.default`
- L2：`TYPECHO_CACHE` KV namespace
- L3：Astro SSR 与 D1

只有公开、匿名、无敏感查询参数的 `200 text/html` 响应会写入缓存。后台的手动刷新通过推进缓存域代际号完成，不会遍历 KV 或主动预热页面。

插件启用状态是页面缓存的唯一总开关。L1 与 L2 可配置为 1、3 或 7 天，默认列表缓存 1 天、详情缓存 7 天。

评论列表由前台 API 实时加载，因此评论创建、审核、撤回和删除不会自动刷新页面缓存。主题在缓存 HTML 中直接输出的评论计数可能延迟更新，可在插件管理页手动刷新对应缓存域。

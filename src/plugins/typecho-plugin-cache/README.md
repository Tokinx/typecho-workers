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

Cloudflare Git Builds 使用构建变量 `TYPECHO_CF_KV_NAMESPACE_ID`。缺少绑定时插件保持 fail-open，页面继续使用核心 Cache API 缓存。

## 缓存链路

- L1：当前 Cloudflare PoP 的 `caches.default`
- L2：`TYPECHO_CACHE` KV namespace
- L3：Astro SSR 与 D1

只有公开、匿名、无敏感查询参数的 `200 text/html` 响应会写入缓存。后台的手动刷新通过推进缓存域代际号完成，不会遍历 KV 或主动预热页面。

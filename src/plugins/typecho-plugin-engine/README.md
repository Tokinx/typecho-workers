# Engine

AI 智能引擎：写作辅助、自动摘要、搜索方式。

设置页：`/admin/plugin/engine`（插件列表「设置」入口）。

## 功能

- **写作辅助**：文章/页面编辑器内生成、润色、纠错、继续调整（OpenAI 兼容 LLM）
- **摘要设置**：发布时可选自动生成；关闭时写入正文截断摘要（约 300 字）
- **一键摘要**：设置页串行为全部已发布文章/页面生成 AI 摘要（失败重试 3 次）
- **搜索方式**：默认站内搜索（标题 + 正文）/ Bing / Google

## 配置

存于 `typecho_options`：`plugin:typecho-plugin-engine`

| 字段 | 说明 |
|------|------|
| `endpoint` / `apiKey` / `model` / `temperature` / `maxTokens` | LLM 基础设置 |
| `autoSummary` | `"0"` / `"1"` |
| `searchProvider` | `default` \| `bing` \| `google` |

摘要写入 `typecho_fields`，`name = engine_summary`。

## 搜索行为

- 默认使用现有标题 + 正文 LIKE 查询，不维护 FTS 表或内存搜索索引。
- Bing / Google 模式下，前台表单由浏览器直接跳转到固定搜索引擎地址，查询为 `关键词 site:正式站点域名`；提交不经过本站重定向。
- 域名取自保存的 `siteUrl`，不使用当前请求或预览地址；外部结果取决于收录情况，不保证实时或完整。
- 外部模式通过 `route:request` 在标准配置/插件初始化后、分页改写与页面渲染前，对 `/search`、`/search/*`、首页 `?s=` 与首页表单 POST `s` 返回轻量 404（no-store）。配置/启动检查仍可能产生数据库读取，不承诺爬虫请求零读取。
- 保存设置沿用 `setOption` 的配置及公共页面缓存失效链路；跨实例遵循既有缓存传播时效。
- 插件停用或未知配置值时恢复默认站内搜索。旧 `searchScope` 被忽略，不会自动启用外部搜索；下次保存写入 `searchProvider`。
- 单独配置搜索不需要 AI API Key；开启智能摘要仍须完整 AI 配置。
- 使用 `archive:footer` 注入脚本，自动识别原有 `name="s"` 且 action 指向本站首页或 `/search/*` 的表单；无需修改主题或添加 Engine 专属属性。使用 Base 或标准前台 hook 的主题均可接入；绕过前台 hook 的第三方主题需自行调用标准 hook。
- 外部直跳需要 JavaScript；禁用时由插件 footer 显示搜索引擎链接和手动搜索提示。
- 脚本支持 InstantClick：每次提交读取当前页面配置，页面不含插件标记时保持原生提交；重复执行不累积监听器。默认模式不注入脚本。
- provider 配置解析、浏览器跳转、请求判断与 404 响应全部位于插件内的 `search.ts`；核心不读取 Engine 配置。
- 已部署过实验 FTS 的数据库不自动删表；遗留 `typecho_engine_fts` 不再读写。如需回收空间，应备份后另行清理，不修改 Drizzle 迁移。

## 开发

```bash
bun run test src/plugins/typecho-plugin-engine/
```

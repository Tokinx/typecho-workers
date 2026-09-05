# Engine

AI 智能引擎：写作辅助、自动摘要、站内搜索范围。

设置页：`/admin/plugin/engine`（插件列表「设置」入口）。

## 功能

- **写作辅助**：文章/页面编辑器内生成、润色、纠错、继续调整（OpenAI 兼容 LLM）
- **摘要设置**：发布时可选自动生成；关闭时写入正文截断摘要（约 300 字）
- **一键摘要**：设置页串行为全部已发布文章/页面生成 AI 摘要（失败重试 3 次）
- **搜索范围**：默认（标题+正文）/ 仅标题 / 标题+摘要

## 配置

存于 `typecho_options`：`plugin:typecho-plugin-engine`

| 字段 | 说明 |
|------|------|
| `endpoint` / `apiKey` / `model` / `temperature` / `maxTokens` | LLM 基础设置 |
| `autoSummary` | `"0"` / `"1"` |
| `searchScope` | `default` \| `title` \| `title_summary` |

摘要写入 `typecho_fields`，`name = engine_summary`。

## 开发

```bash
bun run test src/plugins/typecho-plugin-engine/
```

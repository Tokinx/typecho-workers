# PostPilot

Typecho-CF AI 写作助手插件，接入 OpenAI 兼容 LLM，在编辑器中生成、润色和纠错正文。

## 功能

- **生成** — 根据标题和正文上下文，调用 LLM 续写或生成文章草稿
- **润色** — 保持原意前提下优化表达、结构和可读性
- **纠错** — 修正语法、用词和格式问题
- **风格参考** — 自动采样最近 N 篇已发布文章作为作者风格样本
- **多语言输出** — 支持中/英/日/韩及自动检测
- **附件感知** — 可选将正文图片以 `image_url` 发送给视觉模型

## 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `endpoint` | text | `https://open.bigmodel.cn/api/paas/v4/` | OpenAI 兼容 Base URL |
| `apiKey` | password | — | LLM 服务商 API Key |
| `model` | text | `glm-4.7-flash` | 模型名称 |
| `temperature` | text | `0.7` | 生成创造性控制 |
| `maxTokens` | text | `32000` | 单次最大输出 Token 数（上限 512K / 512000） |

## 编辑器写作设置

编辑器 AI 菜单内置以下设置项，并在当前浏览器通过 `localStorage` 记忆：

- User Prompt：textarea
- 输出语言：select（自动/简体中文/繁体中文/English/日本語/한국어）
- 高级设置（默认折叠）：
  - 参考历史文章：0-不参考 / 5（默认）/ 10
  - 目标读者：input，默认空
  - 篇幅策略：偏短 / 标准（默认）/ 深入
  - 事实策略：保守（默认）/ 允许低风险常识推断
  - 发送正文图片和附件：checkbox，默认不选中

## 工作流程

```
配置保存
  → plugin:config:beforeSave hook 触发
  → 校验 endpoint 格式、必填项和数值范围
  → 保存配置；模型可用性在用户调用 AI 写作时反馈

编辑器页面加载
  → admin:writePost:bottom / admin:writePage:bottom hook 注入 AI 按钮 UI
  → 按钮组：生成 / 润色 / 纠错
  → 发送时收集标题、正文、附件 ID

用户点击操作
  → 弹出独立预览窗口（编辑器正文不受影响）
  → plugin:<id>:action hook 触发（generate/polish/correct）
  → 读取编辑器写作设置与风格样本（最近 N 篇已发布文章）
  → 构建 system prompt（含写作设置、风格样本、附件资料等）
  → 调用 LLM（stream 模式），AI 结果流式实时显示在预览窗口

继续调整
  → 在预览窗口下方输入调整要求，点击「发送调整」
  → plugin:<id>:action hook 触发（continue）
  → 将编辑器原文、当前 AI 结果与调整要求一并提交给 LLM
  → 调整结果流式替换预览内容，可多次迭代调整

确认插入
  → 预览确认无误后点击「确定」，最终结果才写入编辑器
  → 取消 / 关闭窗口则编辑器正文保持原样
```

## 注册的 Hook

| Hook | 类型 | 用途 |
|------|------|------|
| `admin:writePost:bottom` | filter | 文章编辑器底部注入 AI 操作按钮 |
| `admin:writePage:bottom` | filter | 页面编辑器底部注入 AI 操作按钮 |
| `plugin:config:beforeSave` | filter | 保存前校验 LLM 配置格式（模型可用性在调用时反馈） |
| `plugin:<id>:action` | action | 处理 generate/polish/correct/continue 操作 |

## 依赖

- OpenAI 兼容 LLM API（如智谱 GLM、DeepSeek、OpenAI 等）
- `drizzle-orm`（读取风格样本文章）

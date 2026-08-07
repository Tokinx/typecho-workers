# 主题开发规范

> 本文档是 Typecho-Workers 主题开发的完整参考。以 `typecho-theme-warm/` 目录为默认主题示例。

[English](README.en.md)

---

## 目录结构

```
typecho-theme-example/
├── package.json        # npm 包声明（keywords 必须包含 typecho + theme）
├── theme.json          # 主题元数据（样式表声明）
├── style.css           # 主样式表
└── components/         # 可选：自定义模板组件
    ├── Index.astro     # 首页（文章列表）
    ├── Post.astro      # 文章详情
    ├── Page.astro      # 独立页面
    ├── Archive.astro   # 归档页（分类/标签/作者/搜索）
    └── NotFound.astro  # 404 页
```

无 `components/` 目录时为纯 CSS 主题，系统自动回退到默认主题的模板组件。

---

## package.json

```json
{
  "name": "typecho-theme-example",
  "version": "1.0.0",
  "description": "主题描述",
  "author": "Your Name",
  "license": "MIT",
  "keywords": ["typecho", "theme"],
  "files": [
    "theme.json",
    "style.css",
    "components/"
  ]
}
```

**关键约束**：
- `keywords` 必须同时包含 `"typecho"` 和 `"theme"`，否则构建时不会被发现
- `files` 声明要发布的文件（本地开发可省略）

---

## theme.json

```json
{
  "id": "typecho-theme-example",
  "name": "示例主题",
  "description": "主题描述",
  "author": "Your Name",
  "authorUrl": "https://example.com",
  "version": "1.0.0",
  "homepage": "https://github.com/...",
  "license": "MIT",
  "stylesheet": "style.css",
  "stylesheets": ["normalize.css", "grid.css"]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 主题唯一标识，与 npm 包名一致 |
| `name` | 是 | 显示名称 |
| `stylesheet` | 是 | 主 CSS 文件名（构建时复制到 `public/themes/{id}/`） |
| `stylesheets` | 否 | 额外 CSS 文件列表（按顺序加载，在 `stylesheet` 之前） |
| `pageTemplates` | 否 | 独立页面可选模板，键为保存值，包含显示名与 Astro 组件路径 |
| `config` | 否 | 外观设置字段定义，显示在后台「设置外观」页面 |

> **配置优先级**：`theme.json` > `package.json` 中 `typecho.theme` 字段 > 自动推导。

### 外观设置

`config` 使用与插件配置相同的 Typecho 字段定义，支持 `text`、`textarea`、`select`、`radio`、`checkbox`、`password` 和 `hidden`。`radio` 和带选项的 `checkbox` 可设置 `"multiline": true`，以使用 Typecho `multiMode()` 一致的纵向选项布局。配置保存在 `theme:{id}` 选项中；切换到其他外观时，旧外观的设置会被删除。主题组件通过 `loadThemeConfig(options, themeId)` 读取设置。

```json
{
  "config": {
    "logoUrl": {
      "type": "text",
      "label": "站点 LOGO 地址",
      "description": "填写图片 URL",
      "default": ""
    }
  }
}
```

### 独立页面模板

页面编辑器会将此配置显示为与 Typecho 1.3.0 一致的选择框。组件路径必须位于主题的 `components/` 目录内，选择后会同时用于前台页面和后台预览。

```json
{
  "pageTemplates": {
    "landing": {
      "name": "落地页",
      "component": "components/PageLanding.astro"
    }
  }
}
```

---

## 模板组件 Props

所有模板组件 Props 类型定义在主项目的 `src/lib/theme-props.ts` 中。

### 公共 Props（ThemeBaseProps，所有组件均包含）

```typescript
interface ThemeBaseProps {
  options: SiteOptions;          // 站点配置（title, description, timezone 等）
  urls: {                        // 计算后的 URL 集合
    siteUrl: string;
    adminUrl: string;
    loginUrl: string;
    logoutUrl: string;
    profileUrl: string;
    feedUrl: string;
    commentsFeedUrl: string;
  };
  user: UserRow | null;          // 当前登录用户（未登录为 null）
  isLoggedIn: boolean;
  pages: Array<{                 // 导航页面列表（状态为 publish 的独立页面）
    title: string;
    slug: string;
    permalink: string;
  }>;
  sidebarData: SidebarData;      // 侧边栏数据（分类、标签、最近文章等）
  currentPath: string;           // 当前请求路径
}
```

### Index.astro（ThemeIndexProps）

```typescript
interface ThemeIndexProps extends ThemeBaseProps {
  posts: PostListItem[];         // 文章列表
  pagination: PaginationInfo;    // 前看分页（仅上一页/下一页）
}
```

### Post.astro（ThemePostProps）

```typescript
interface ThemePostProps extends ThemeBaseProps {
  post: {
    cid: number;
    title: string;
    permalink: string;
    content: string;             // 已渲染的 HTML（经过 Hook 过滤）
    created: number;             // Unix 时间戳（秒）
    modified: number | null;
    commentsNum: number;
    allowComment: boolean;
    hasPassword: boolean;        // 是否密码保护
    passwordVerified: boolean;   // 访问者是否已输入正确密码
  };
  author: { uid: number; name: string; screenName: string } | null;
  categories: Array<{ name: string; slug: string; permalink: string }>;
  tags: Array<{ name: string; slug: string; permalink: string }>;
  comments: CommentNode[];
  commentOptions: CommentOptions;
  prevPost: { title: string; permalink: string } | null;
  nextPost: { title: string; permalink: string } | null;
  gravatarMap: Record<number, string>;  // coid → Gravatar URL
}
```

### Page.astro（ThemePageProps）

```typescript
interface ThemePageProps extends ThemeBaseProps {
  page: {
    cid: number;
    title: string;
    slug: string;
    permalink: string;
    content: string;             // 已渲染的 HTML
    created: number;
    allowComment: boolean;
    hasPassword: boolean;
    passwordVerified: boolean;
  };
  comments: CommentNode[];
  commentOptions: CommentOptions;
  gravatarMap: Record<number, string>;
}
```

### Archive.astro（ThemeArchiveProps）

```typescript
interface ThemeArchiveProps extends ThemeBaseProps {
  archiveTitle: string;          // 如 "分类 技术 下的文章"
  archiveType: 'category' | 'tag' | 'author' | 'search';
  posts: PostListItem[];
  pagination: PaginationInfo;
}
```

### 公开归档分页

公开的 `Index.astro` 与 `Archive.astro` 使用 `pageSize + 1` 前看查询。
此时 `pagination.totalsExact` 为 `false`，`totalItems` 和 `totalPages`
均为 `null`。主题只能根据 `hasPrev` / `prevUrl` 与 `hasNext` / `nextUrl`
渲染上一页、下一页，不能渲染数字页码或推算总页数。直接访问末页之后的
页面会由当前主题的 `NotFound.astro` 渲染为 HTTP 404。

### NotFound.astro（ThemeNotFoundProps）

```typescript
interface ThemeNotFoundProps extends ThemeBaseProps {
  statusCode: number;            // 404
  errorTitle: string;
}
```

### 共享子类型

```typescript
interface PostListItem {
  cid: number;
  title: string;
  permalink: string;
  excerpt: string;               // 渲染后的 HTML 摘要（支持 <!--more-->）
  created: number;
  commentsNum: number;
  author: { uid: number; name: string; screenName: string } | null;
  categories: Array<{ name: string; slug: string; permalink: string }>;
}

interface CommentNode {
  coid: number;
  author: string;
  mail: string;
  url: string;
  status: 'approved' | 'waiting' | 'spam';
  text: string;                  // 渲染后的 HTML
  created: number;
  children: CommentNode[];       // 嵌套回复
}
```

---

## Astro 组件示例

```astro
---
// components/Index.astro
import type { ThemeIndexProps } from '@/lib/theme-props';

type Props = ThemeIndexProps;

const { options, posts, pagination, urls, isLoggedIn, user, pages, sidebarData } = Astro.props;
---

<html lang="zh">
<head>
  <meta charset="utf-8" />
  <title>{options.title}</title>
  <!-- 主样式由系统自动注入，无需在此 link -->
</head>
<body>
  <header>
    <a href={urls.siteUrl}>{options.title}</a>
  </header>

  <main>
    {posts.map(post => (
      <article>
        <h2><a href={post.permalink}>{post.title}</a></h2>
        <Fragment set:html={post.excerpt} />
      </article>
    ))}
  </main>

  {pagination.hasNext && (
    <a href={`/?page=${pagination.currentPage + 1}`}>下一页</a>
  )}
</body>
</html>
```

> 注意：`Base.astro` 布局是系统内置布局，主题组件**不需要**引用它（主题直接输出完整 HTML）。系统通过构建时虚拟模块动态选择当前激活主题的组件。

---

## 样式加载机制

系统自动在 `<head>` 中注入以下 `<link>` 标签（基于 `theme.json`）：

```html
<!-- stylesheets 列表（按顺序） -->
<link rel="stylesheet" href="/themes/typecho-theme-example/normalize.css">
<link rel="stylesheet" href="/themes/typecho-theme-example/grid.css">
<!-- 主样式 stylesheet -->
<link rel="stylesheet" href="/themes/typecho-theme-example/style.css">
```

> 主题组件不需要自行 `<link>` 样式文件。

---

## 安装到项目

### 本地开发（工作区包）

1. 将主题目录放在 `src/themes/` 下
2. 在根 `package.json` 的 `workspaces` 中添加路径（如已有 `src/themes/*` 则自动包含）
3. 运行 `bun install`
4. 重新执行 `bun run build`
5. 在管理后台「外观」页面切换到新主题

### npm 发布后安装

```bash
bun add typecho-theme-example
bun run build
```

---

## 参考示例

`typecho-theme-warm/` 目录演示了：
- 完整 5 个模板组件与 Notes 混合时间线
- 公共 HTML 与 API 异步评论组件
- `ThemePostProps` 的文章详情、评论和相邻文章导航
- 内容列表与评论列表的渐进式加载

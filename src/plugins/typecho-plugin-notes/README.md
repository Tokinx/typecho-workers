# 笔记插件

为 Typecho-Workers 增加独立的 `note` 内容类型和 `note_topic` 术语类型。插件不修改核心
Schema，数据存放在现有的 `typecho_contents`、`typecho_metas`、
`typecho_relationships` 和 `typecho_fields` 表中。

启用插件后，从后台「管理 -> 笔记」进入时间线管理页。页面支持：

- 快速发布 Markdown/HTML 笔记，设置公开、私密或草稿状态
- 自动从正文提取 `#话题` 并同步到 `note_topic`；一次笔记可关联多个话题
- 编辑、删除笔记，点击评论数查看评论列表并回复；保留旧 `topicMid` 写入参数以兼容早期调用
- 通过核心上传接口插入图片
- 支持上传附件；附件存入核心 `attachment` 内容类型并持久化在 `typecho_fields.note_attachments`（cid 数组），
  主题可通过`NoteListItem.attachments`（`cid`/`name`/`url`/`size`/`type`）渲染文件链接
- 对任意 `/note/<cid>` 引用生成指向笔记详情页的链接
- 公开笔记复用 Post 详情页和核心评论表单，后台笔记页面可集中查看和回复评论
- 点赞不属于本插件，后续可由独立 Like 插件实现

## 主题变量

插件不修改核心主题 Props，也不提供前台 HTTP API。主题在 Astro frontmatter 中调用
`getNotesStreamForTheme()`，一次只加载当前需要的 `notes` 或 `mixed` 流，渲染过程不需要浏览器请求。
匿名访问时只包含已公开且未到未来发布时间的笔记；传入当前用户的 `viewerUid` 后，还会包含该用户
自己的私密笔记。草稿不会进入任何主题变量，只能在后台笔记管理页面查看。

以主题的 `Index.astro` 为例：

```ts
import { env } from 'cloudflare:workers';
import { getDb } from 'typecho/db';
import { getNotesStreamForTheme } from 'typecho-plugin-notes';

const { items, pagination } = await getNotesStreamForTheme(
  getDb(env.DB),
  'mixed',
  {
    page: 1,
    pageSize: 10,
    topic: Astro.url.searchParams.get('topic'),
    viewerUid: user?.uid,
  },
  { siteUrl: urls.siteUrl, permalinkPattern: options.permalinkPattern },
);
```

传入 `'notes'` 可输出纯笔记列表，传入 `'mixed'` 可输出按发布时间合并的文章与笔记列表。列表项目
带有 `type: 'note' | 'post'`、`html`、`source`、`topics`、`comments` 与 `permalink`；话题已经在
`html` 原文中以 `note-topic-highlight` 标记。笔记的 `permalink` 指向 `/note/{cid}`，详情直接复用
当前主题的 `Post.astro`。

公开流使用 `pageSize + 1` 前看分页，`pagination.totalsExact` 固定为 `false`，主题仅根据
`hasPrev` 与 `hasNext` 渲染前后页。匿名结果会按流、页码、页大小、话题、站点 URL 和固定链接模式
进入共享 `notes` 缓存域；传入 `viewerUid` 的私密视图不会使用共享缓存。旧的
`getNotesForTheme()` 仍保留给需要同时读取两条流和精确总数的兼容调用，但不适合前台主题列表。

公开笔记默认开启评论，直接复用 Post 详情中的 `/api/comment` 表单、审核设置、反垃圾校验与回复流程。
私密笔记和草稿关闭评论；后台笔记评论弹窗仍可查看已有评论并以管理员身份回复。

WordPress WXR 迁移脚本会把 `post_type=note` 转为该数据格式，并将 WordPress
的 `topic` taxonomy 转为 `note_topic`。迁移脚本默认自动启用本插件。

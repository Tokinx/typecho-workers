# Theme Development Guide

> This document is the complete reference for Typecho-Workers theme development. `typecho-theme-warm/` is the default theme example.

[中文](README.md)

---

## Directory Structure

```
typecho-theme-example/
├── package.json        # npm package manifest (keywords must include typecho + theme)
├── theme.json          # Theme metadata (stylesheet declaration)
├── style.css           # Main stylesheet
└── components/         # Optional: custom template components
    ├── Index.astro     # Home page (post list)
    ├── Post.astro      # Post detail
    ├── Page.astro      # Independent page
    ├── Archive.astro   # Archive (category/tag/author/search)
    └── NotFound.astro  # 404 page
```

Themes without a `components/` directory are CSS-only themes — the system automatically falls back to the default theme's template components.

---

## package.json

```json
{
  "name": "typecho-theme-example",
  "version": "1.0.0",
  "description": "Theme description",
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

**Key constraints**:
- `keywords` must include both `"typecho"` and `"theme"` — otherwise the build-time scanner won't discover it
- `files` declares what to publish (can be omitted for local development)

---

## theme.json

```json
{
  "id": "typecho-theme-example",
  "name": "Example Theme",
  "description": "Theme description",
  "author": "Your Name",
  "authorUrl": "https://example.com",
  "version": "1.0.0",
  "homepage": "https://github.com/...",
  "license": "MIT",
  "stylesheet": "style.css",
  "stylesheets": ["normalize.css", "grid.css"]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique theme identifier, matches npm package name |
| `name` | Yes | Display name |
| `stylesheet` | Yes | Main CSS filename (copied to `public/themes/{id}/` at build time) |
| `stylesheets` | No | Additional CSS files (loaded in order, before `stylesheet`) |
| `pageTemplates` | No | Selectable page templates, keyed by stored value with a label and Astro component path |
| `config` | No | Appearance fields rendered on the admin "Set Appearance" page |

> **Config priority**: `theme.json` > `package.json` `typecho.theme` field > auto-inferred.

### Appearance settings

`config` uses the same Typecho field definitions as plugin settings and supports `text`, `textarea`, `select`, `radio`, `checkbox`, `password`, and `hidden`. Set `"multiline": true` on `radio` or option-based `checkbox` fields to use Typecho `multiMode()`-compatible vertical options. Values are stored under `theme:{id}`; switching themes removes the previous theme's settings. Theme components can read them with `loadThemeConfig(options, themeId)`.

### Page templates

The page editor presents these declarations in the Typecho 1.3-style select control. Components must live under the theme's `components/` directory; the selected component is used for both public rendering and admin preview.

```json
{
  "pageTemplates": {
    "landing": {
      "name": "Landing page",
      "component": "components/PageLanding.astro"
    }
  }
}
```

---

## Template Component Props

All template component Props types are defined in the main project at `src/lib/theme-props.ts`.

### Base Props (ThemeBaseProps — included in all components)

```typescript
interface ThemeBaseProps {
  options: SiteOptions;          // Site config (title, description, timezone, etc.)
  urls: {                        // Computed URL set
    siteUrl: string;
    adminUrl: string;
    loginUrl: string;
    logoutUrl: string;
    profileUrl: string;
    feedUrl: string;
    commentsFeedUrl: string;
  };
  user: UserRow | null;          // Currently logged-in user (null = anonymous)
  isLoggedIn: boolean;
  pages: Array<{                 // Navigation pages (published independent pages)
    title: string;
    slug: string;
    permalink: string;
  }>;
  sidebarData: SidebarData;      // Sidebar widget data (categories, tags, recent posts, etc.)
  currentPath: string;           // Current request path
}
```

### Index.astro (ThemeIndexProps)

```typescript
interface ThemeIndexProps extends ThemeBaseProps {
  posts: PostListItem[];         // Post list
  pagination: PaginationInfo;    // Lookahead pagination (previous/next only)
}
```

### Post.astro (ThemePostProps)

```typescript
interface ThemePostProps extends ThemeBaseProps {
  post: {
    cid: number;
    title: string;
    permalink: string;
    content: string;             // Rendered HTML (processed through Hook filters)
    created: number;             // Unix timestamp (seconds)
    modified: number | null;
    commentsNum: number;
    allowComment: boolean;
    hasPassword: boolean;        // Whether the post is password-protected
    passwordVerified: boolean;   // Whether the visitor supplied the correct password
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

### Page.astro (ThemePageProps)

```typescript
interface ThemePageProps extends ThemeBaseProps {
  page: {
    cid: number;
    title: string;
    slug: string;
    permalink: string;
    content: string;             // Rendered HTML
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

### Archive.astro (ThemeArchiveProps)

```typescript
interface ThemeArchiveProps extends ThemeBaseProps {
  archiveTitle: string;          // e.g. "Posts in category: Technology"
  archiveType: 'category' | 'tag' | 'author' | 'search';
  posts: PostListItem[];
  pagination: PaginationInfo;
}
```

### Public archive pagination

The public `Index.astro` and `Archive.astro` streams use a `pageSize + 1`
lookahead query. Their `pagination` object has `totalsExact: false`, and both
`totalItems` and `totalPages` are `null`. Render only `hasPrev` / `prevUrl`
and `hasNext` / `nextUrl`; do not render numeric page links or infer a total
from the current page. A direct request beyond the final page is rendered by
the active theme's `NotFound.astro` with HTTP 404.

### NotFound.astro (ThemeNotFoundProps)

```typescript
interface ThemeNotFoundProps extends ThemeBaseProps {
  statusCode: number;            // 404
  errorTitle: string;
}
```

### Shared Sub-types

```typescript
interface PostListItem {
  cid: number;
  title: string;
  permalink: string;
  excerpt: string;               // Rendered HTML excerpt (<!--more--> supported)
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
  text: string;                  // Rendered HTML
  created: number;
  children: CommentNode[];       // Nested replies
}
```

---

## Astro Component Example

```astro
---
// components/Index.astro
import type { ThemeIndexProps } from '@/lib/theme-props';

type Props = ThemeIndexProps;

const { options, posts, pagination, urls, isLoggedIn, user, pages, sidebarData } = Astro.props;
---

<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>{options.title}</title>
  <!-- Stylesheets are automatically injected by the system — no need to link them here -->
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
    <a href={`/?page=${pagination.currentPage + 1}`}>Next Page</a>
  )}
</body>
</html>
```

> Note: `Base.astro` is a system-internal layout — theme components do **not** need to import it. Themes output full HTML directly. The system selects the active theme's component via a build-time virtual module.

---

## Stylesheet Loading

The system automatically injects the following `<link>` tags into `<head>` (based on `theme.json`):

```html
<!-- stylesheets list (in order) -->
<link rel="stylesheet" href="/themes/typecho-theme-example/normalize.css">
<link rel="stylesheet" href="/themes/typecho-theme-example/grid.css">
<!-- main stylesheet -->
<link rel="stylesheet" href="/themes/typecho-theme-example/style.css">
```

> Theme components do not need to `<link>` stylesheets themselves.

---

## Installing into the Project

### Local development (workspace package)

1. Place the theme directory under `src/themes/`
2. Ensure `src/themes/*` is listed in the root `package.json` `workspaces`
3. Run `bun install`
4. Rebuild with `bun run build`
5. Switch to the new theme in the admin panel under "Appearance"

### Install from npm

```bash
bun add typecho-theme-example
bun run build
```

---

## Reference Example

`typecho-theme-warm/` demonstrates:
- All 5 template components and the Notes mixed timeline
- Public HTML with an API-loaded comment component
- Article details, comments, and adjacent post navigation via `ThemePostProps`
- Progressive content-list and comment-list loading

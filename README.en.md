# Typecho-Workers

[中文](README.md)

A modern rewrite of [Typecho](https://typecho.org) in TypeScript, running on **Astro + Cloudflare Workers + D1**. Preserves Typecho's database schema for seamless data migration from PHP Typecho.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Tokinx/typecho-workers)

---

## Features

**Frontend**: Post list / category / tag / author / search archives, nested comments (Gravatar), RSS 2.0 / Atom 1.0 / RSS 1.0, password-protected posts, responsive default theme

**Admin Dashboard**: Post & page editor, comment moderation, media manager (R2 drag-and-drop upload), user management (5 roles), theme switcher, plugin manager (enable/disable/configure), site settings, installation wizard

**System**: Theme system (npm package distribution), plugin system (Hook mechanism, 50+ hook points), PHP Typecho data migration tool, PBKDF2-SHA256 authentication, CSRF protection, security headers, R2 upload type validation

---

## Installation & Deployment

### Prerequisites

- Node.js 18+
- pnpm (`npm install -g pnpm`)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- Cloudflare account

### Local Development

```bash
# Clone and install dependencies
git clone https://github.com/Tokinx/typecho-workers.git
cd typecho-workers
pnpm install

# Start dev server (D1 + R2 are automatically simulated by wrangler)
pnpm run dev
```

Visit http://localhost:4321 — first visit auto-redirects to the installation wizard.

### Deploy to Cloudflare

**1. Create Cloudflare resources**

```bash
# Create D1 database
wrangler d1 create typecho-db

# Create R2 bucket
wrangler r2 bucket create typecho-uploads

# Optional: create the Edge Cache plugin's KV L2 namespace
wrangler kv namespace create TYPECHO_CACHE
```

**2. Update `wrangler.toml`**

Replace `database_id` with the actual D1 database ID from the previous step:

```toml
[[d1_databases]]
binding = "DB"
database_name = "typecho-db"
database_id = "your-actual-database-id"
```

To enable the Edge Cache plugin, add the KV namespace ID returned by Wrangler:

```toml
[[kv_namespaces]]
binding = "TYPECHO_CACHE"
id = "your-kv-namespace-id"
```

**3. Build and deploy**

```bash
pnpm run deploy
```

After deployment, visit your Worker URL — first visit auto-redirects to the installation wizard.

---

## Command Reference

| Command | Description |
|---------|-------------|
| `pnpm run dev` | Start local dev server |
| `pnpm run build` | Production build |
| `pnpm run deploy` | Build + deploy to Cloudflare Workers |
| `pnpm run test` | Run all tests |
| `pnpm run test:watch` | Watch mode |
| `pnpm run test:coverage` | Generate coverage report |
| `pnpm exec tsc --noEmit` | TypeScript type check |
| `pnpm run db:generate` | Generate Drizzle migrations |
| `pnpm run db:studio` | Launch Drizzle Studio |
| `pnpm run db:migrate:typecho` | Migrate PHP Typecho data; select target and preview mode with options |
| `pnpm run db:migrate:wordpress` | Migrate WordPress WXR XML data |
| `pnpm run reset-password` | Reset user password (local) |
| `pnpm run reset-password:cloudflare` | Reset user password (Cloudflare) |

---

## Migrating from PHP Typecho

### Migration Steps

```bash
# Migrate to Cloudflare (production)
pnpm run db:migrate:typecho -- \
  --target cloudflare \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads

# Migrate to local (development)
pnpm run db:migrate:typecho -- \
  --target local \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads

# Preview mode (no data written)
pnpm run db:migrate:typecho -- \
  --target local \
  --dry-run \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads
```

### Migration Options

| Option | Description | Default |
|--------|-------------|---------|
| `--source`, `-s` | Source SQLite database path | (required) |
| `--uploads`, `-u` | Source `usr/uploads/` directory | (required) |
| `--prefix` | Source table prefix | `typecho_` |
| `--target`, `-t` | Migration target: `local` or `cloudflare` | `local` |
| `--dry-run`, `-n` | Preview mode | `false` |
| `--site-url` | New site URL (for rewriting attachment URLs) | — |
| `--d1-name` | D1 database name | `typecho-db` |
| `--r2-bucket` | R2 bucket name | `typecho-uploads` |

### Reset Password After Migration

Password hashing is incompatible (PHP phpass → SHA-256 + salt), so passwords must be reset after migration:

```bash
# Local
pnpm run reset-password

# Cloudflare
pnpm run reset-password:cloudflare
```

## Migrating from WordPress

### Migration Steps

```bash
# Migrate to Cloudflare (production) and download referenced media to R2
pnpm run db:migrate:wordpress -- \
  --target cloudflare \
  --source WordPress.2026-07-29.xml \
  --author-id 1 \
  --site-url https://blog.example.com \
  --download-media

# Migrate to local (development)
pnpm run db:migrate:wordpress -- \
  --target local \
  --source WordPress.2026-07-29.xml \
  --author-id 1

# Preview mode (no data written)
pnpm run db:migrate:wordpress -- \
  --dry-run \
  --source WordPress.2026-07-29.xml \
  --author-id 1
```

### Migration Options

| Option | Description | Default |
|--------|-------------|---------|
| `--source`, `-s` | WordPress WXR XML file | (required) |
| `--target`, `-t` | Migration target: `local` or `cloudflare` | `local` |
| `--author-id` | Existing target user ID that owns imported content | `1` |
| `--site-url` | New site URL; required when downloading media | — |
| `--download-media` | Download referenced media to R2 and rewrite URLs; retry each failure 3 times, then retain its original URL and report it at the end | `false` |
| `--media-concurrency` | Concurrent media transfers (1-16) | `4` |
| `--max-media-mb` | Maximum size per media file in MB | `50` |
| `--skip-attachments` | Do not create attachment content records | `false` |
| `--override` | Replace existing content/comments and preserve WordPress IDs | `false` |
| `--dry-run`, `-n` | Preview mode | `false` |
| `--d1-name` | D1 database name | `typecho-db` |
| `--r2-bucket` | R2 bucket name | `typecho-uploads` |
| `--output-sql` | Also write the generated SQL to a file | — |

Back up the target D1 database first. `--override true` clears content (including
attachments), comments, fields, and relationships, then writes the original
`post_id` / `comment_id`; users, site settings, categories, tags, and R2 objects remain.

---

## Plugin Development

See [Plugin Development Guide](src/plugins/README.md).

---

## Theme Development

See [Theme Development Guide](src/themes/README.md).

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | [Astro](https://astro.build) 7.x (SSR) |
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) |
| ORM | [Drizzle ORM](https://orm.drizzle.team) |
| File Storage | [Cloudflare R2](https://developers.cloudflare.com/r2/) |
| Testing | [Vitest](https://vitest.dev) |
| Package Manager | pnpm |

---

## Security & Test Rules

- Admin APIs must use `requireAdminAction()` for authentication, authorization, and CSRF checks; admin redirects must be same-origin and limited to `/admin` paths.
- Comment referer checks and post-comment redirects must trust sources by URL `origin`, not by string prefix or host-only comparison.
- Frontend, admin, plugin route, and cache-hit responses are normalized by middleware with baseline security headers.
- Every feature or bug fix needs matching regression coverage and must pass both `pnpm run test` and `pnpm exec tsc --noEmit`.

---

## Compatibility with PHP Typecho

| Aspect | Status |
|--------|--------|
| Database schema | ✅ Fully compatible, can import SQLite DB directly |
| Default theme style | ✅ CSS & HTML structure matches Typecho default theme |
| URL structure | ✅ Routes match Typecho default permalink settings |
| Password hashing | ⚠️ Reset required after migration (different algorithm) |
| PHP themes / plugins | ❌ Must be repackaged in the new format (TypeScript / npm) |

---

## License

MIT

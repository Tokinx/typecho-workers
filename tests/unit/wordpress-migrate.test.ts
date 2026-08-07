import { describe, expect, it, vi } from 'vitest';
import {
  buildWordPressMigrationDataset,
  buildWordPressMigrationStatements,
  buildWordPressOverrideStatements,
  buildWordPressOverrideTargetState,
  parseWordPressExport,
  sqlLiteral,
  type WordPressTargetState,
} from '../../scripts/wordpress';
import {
  MEDIA_TRANSFER_RETRY_COUNT,
  parseWordPressMigrationArgs,
  transferMediaWithRetries,
} from '../../scripts/migrate-wordpress';

const WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>Fixture Blog</title><link>https://old.example</link>
  <wp:base_blog_url>https://old.example</wp:base_blog_url>
  <wp:author><wp:author_login><![CDATA[admin]]></wp:author_login><wp:author_email><![CDATA[a@example.com]]></wp:author_email><wp:author_display_name><![CDATA[Admin]]></wp:author_display_name></wp:author>
  <wp:category><wp:category_nicename><![CDATA[coding]]></wp:category_nicename><wp:cat_name><![CDATA[代码]]></wp:cat_name><wp:category_parent><![CDATA[]]></wp:category_parent></wp:category>
  <wp:tag><wp:tag_slug><![CDATA[typescript]]></wp:tag_slug><wp:tag_name><![CDATA[TypeScript]]></wp:tag_name></wp:tag>
  <wp:term><wp:term_taxonomy><![CDATA[topic]]></wp:term_taxonomy><wp:term_slug><![CDATA[daily]]></wp:term_slug><wp:term_name><![CDATA[日常]]></wp:term_name><wp:term_parent><![CDATA[]]></wp:term_parent></wp:term>
  <item>
    <title><![CDATA[Hello's World]]></title><guid isPermaLink="false">wp:10</guid><dc:creator><![CDATA[admin]]></dc:creator>
    <content:encoded><![CDATA[<p>Hello <img src="https://old.example/wp-content/uploads/2024/01/a.jpg"></p>]]></content:encoded><excerpt:encoded><![CDATA[Summary]]></excerpt:encoded>
    <wp:post_id>10</wp:post_id><wp:post_date><![CDATA[2024-01-02 08:00:00]]></wp:post_date><wp:post_date_gmt><![CDATA[2024-01-02 00:00:00]]></wp:post_date_gmt><wp:post_modified_gmt><![CDATA[2024-01-03 00:00:00]]></wp:post_modified_gmt>
    <wp:comment_status><![CDATA[open]]></wp:comment_status><wp:ping_status><![CDATA[open]]></wp:ping_status><wp:post_name><![CDATA[hello]]></wp:post_name><wp:status><![CDATA[publish]]></wp:status><wp:post_parent>0</wp:post_parent><wp:menu_order>0</wp:menu_order><wp:post_type><![CDATA[post]]></wp:post_type><wp:post_password><![CDATA[]]></wp:post_password>
    <category domain="category" nicename="coding"><![CDATA[代码]]></category><category domain="post_tag" nicename="typescript"><![CDATA[TypeScript]]></category>
    <wp:postmeta><wp:meta_key><![CDATA[_thumbnail_id]]></wp:meta_key><wp:meta_value><![CDATA[30]]></wp:meta_value></wp:postmeta>
    <wp:postmeta><wp:meta_key><![CDATA[_wp_old_slug]]></wp:meta_key><wp:meta_value><![CDATA[old-one]]></wp:meta_value></wp:postmeta>
    <wp:postmeta><wp:meta_key><![CDATA[_wp_old_slug]]></wp:meta_key><wp:meta_value><![CDATA[old-two]]></wp:meta_value></wp:postmeta>
    <wp:comment><wp:comment_id>100</wp:comment_id><wp:comment_author><![CDATA[Alice]]></wp:comment_author><wp:comment_author_email><![CDATA[alice@example.com]]></wp:comment_author_email><wp:comment_author_url><![CDATA[]]></wp:comment_author_url><wp:comment_author_IP><![CDATA[127.0.0.1]]></wp:comment_author_IP><wp:comment_date_gmt><![CDATA[2024-01-04 00:00:00]]></wp:comment_date_gmt><wp:comment_content><![CDATA[First]]></wp:comment_content><wp:comment_approved><![CDATA[1]]></wp:comment_approved><wp:comment_type><![CDATA[comment]]></wp:comment_type><wp:comment_parent>0</wp:comment_parent><wp:comment_user_id>0</wp:comment_user_id></wp:comment>
    <wp:comment><wp:comment_id>101</wp:comment_id><wp:comment_author><![CDATA[Admin]]></wp:comment_author><wp:comment_author_email><![CDATA[a@example.com]]></wp:comment_author_email><wp:comment_author_url><![CDATA[]]></wp:comment_author_url><wp:comment_author_IP><![CDATA[]]></wp:comment_author_IP><wp:comment_date_gmt><![CDATA[2024-01-04 01:00:00]]></wp:comment_date_gmt><wp:comment_content><![CDATA[Reply]]></wp:comment_content><wp:comment_approved><![CDATA[1]]></wp:comment_approved><wp:comment_type><![CDATA[comment]]></wp:comment_type><wp:comment_parent>100</wp:comment_parent><wp:comment_user_id>1</wp:comment_user_id></wp:comment>
  </item>
  <item><title><![CDATA[Draft]]></title><guid>wp:11</guid><content:encoded><![CDATA[draft body]]></content:encoded><excerpt:encoded><![CDATA[]]></excerpt:encoded><wp:post_id>11</wp:post_id><wp:post_date_gmt><![CDATA[2024-02-01 00:00:00]]></wp:post_date_gmt><wp:post_modified_gmt><![CDATA[2024-02-01 00:00:00]]></wp:post_modified_gmt><wp:comment_status><![CDATA[closed]]></wp:comment_status><wp:ping_status><![CDATA[closed]]></wp:ping_status><wp:post_name><![CDATA[draft]]></wp:post_name><wp:status><![CDATA[draft]]></wp:status><wp:post_parent>0</wp:post_parent><wp:menu_order>0</wp:menu_order><wp:post_type><![CDATA[post]]></wp:post_type><wp:post_password><![CDATA[]]></wp:post_password></item>
  <item><title><![CDATA[]]></title><guid>wp:20</guid><content:encoded><![CDATA[今天的笔记]]></content:encoded><excerpt:encoded><![CDATA[]]></excerpt:encoded><wp:post_id>20</wp:post_id><wp:post_date_gmt><![CDATA[2024-03-01 00:00:00]]></wp:post_date_gmt><wp:post_modified_gmt><![CDATA[2024-03-01 00:00:00]]></wp:post_modified_gmt><wp:comment_status><![CDATA[open]]></wp:comment_status><wp:ping_status><![CDATA[closed]]></wp:ping_status><wp:post_name><![CDATA[20]]></wp:post_name><wp:status><![CDATA[private]]></wp:status><wp:post_parent>0</wp:post_parent><wp:menu_order>0</wp:menu_order><wp:post_type><![CDATA[note]]></wp:post_type><wp:post_password><![CDATA[]]></wp:post_password><category domain="topic" nicename="daily"><![CDATA[日常]]></category><wp:postmeta><wp:meta_key><![CDATA[praise]]></wp:meta_key><wp:meta_value><![CDATA[7]]></wp:meta_value></wp:postmeta><wp:postmeta><wp:meta_key><![CDATA[images]]></wp:meta_key><wp:meta_value><![CDATA[30]]></wp:meta_value></wp:postmeta></item>
  <item><title><![CDATA[a.jpg]]></title><guid>https://old.example/wp-content/uploads/2024/01/a.jpg</guid><content:encoded><![CDATA[]]></content:encoded><excerpt:encoded><![CDATA[]]></excerpt:encoded><wp:post_id>30</wp:post_id><wp:post_date_gmt><![CDATA[2024-01-02 00:00:00]]></wp:post_date_gmt><wp:post_modified_gmt><![CDATA[2024-01-02 00:00:00]]></wp:post_modified_gmt><wp:comment_status><![CDATA[closed]]></wp:comment_status><wp:ping_status><![CDATA[closed]]></wp:ping_status><wp:post_name><![CDATA[a-jpg]]></wp:post_name><wp:status><![CDATA[inherit]]></wp:status><wp:post_parent>40</wp:post_parent><wp:menu_order>0</wp:menu_order><wp:post_type><![CDATA[attachment]]></wp:post_type><wp:post_password><![CDATA[]]></wp:post_password><wp:attachment_url><![CDATA[https://old.example/wp-content/uploads/2024/01/a.jpg]]></wp:attachment_url></item>
  <item><title><![CDATA[About]]></title><guid>wp:40</guid><content:encoded><![CDATA[<p>About us</p>]]></content:encoded><excerpt:encoded><![CDATA[About summary]]></excerpt:encoded><wp:post_id>40</wp:post_id><wp:post_date_gmt><![CDATA[2024-04-01 00:00:00]]></wp:post_date_gmt><wp:post_modified_gmt><![CDATA[2024-04-02 00:00:00]]></wp:post_modified_gmt><wp:comment_status><![CDATA[open]]></wp:comment_status><wp:ping_status><![CDATA[closed]]></wp:ping_status><wp:post_name><![CDATA[about]]></wp:post_name><wp:status><![CDATA[publish]]></wp:status><wp:post_parent>0</wp:post_parent><wp:menu_order>2</wp:menu_order><wp:post_type><![CDATA[page]]></wp:post_type><wp:post_password><![CDATA[page-password]]></wp:post_password><wp:postmeta><wp:meta_key><![CDATA[_thumbnail_id]]></wp:meta_key><wp:meta_value><![CDATA[30]]></wp:meta_value></wp:postmeta><wp:comment><wp:comment_id>102</wp:comment_id><wp:comment_author><![CDATA[Bob]]></wp:comment_author><wp:comment_author_email><![CDATA[bob@example.com]]></wp:comment_author_email><wp:comment_author_url><![CDATA[]]></wp:comment_author_url><wp:comment_author_IP><![CDATA[127.0.0.2]]></wp:comment_author_IP><wp:comment_date_gmt><![CDATA[2024-04-03 00:00:00]]></wp:comment_date_gmt><wp:comment_content><![CDATA[Page comment]]></wp:comment_content><wp:comment_approved><![CDATA[1]]></wp:comment_approved><wp:comment_type><![CDATA[comment]]></wp:comment_type><wp:comment_parent>0</wp:comment_parent><wp:comment_user_id>0</wp:comment_user_id></wp:comment></item>
  <item><title><![CDATA[Team]]></title><guid>wp:41</guid><content:encoded><![CDATA[Team draft]]></content:encoded><excerpt:encoded><![CDATA[]]></excerpt:encoded><wp:post_id>41</wp:post_id><wp:post_date_gmt><![CDATA[2024-04-04 00:00:00]]></wp:post_date_gmt><wp:post_modified_gmt><![CDATA[2024-04-04 00:00:00]]></wp:post_modified_gmt><wp:comment_status><![CDATA[closed]]></wp:comment_status><wp:ping_status><![CDATA[closed]]></wp:ping_status><wp:post_name><![CDATA[team]]></wp:post_name><wp:status><![CDATA[draft]]></wp:status><wp:post_parent>40</wp:post_parent><wp:menu_order>5</wp:menu_order><wp:post_type><![CDATA[page]]></wp:post_type><wp:post_password><![CDATA[]]></wp:post_password></item>
</channel></rss>`;

const TARGET: WordPressTargetState = {
  maxContentId: 40,
  maxCommentId: 200,
  maxMetaId: 10,
  contentSlugs: ['hello'],
  metas: [{ mid: 5, type: 'category', slug: 'coding' }],
};

describe('WordPress WXR migration', () => {
  it('parses WXR without coercing IDs or CDATA values', () => {
    const parsed = parseWordPressExport(WXR);
    expect(parsed.siteTitle).toBe('Fixture Blog');
    expect(parsed.authors[0]).toMatchObject({ login: 'admin', displayName: 'Admin' });
    expect(parsed.items).toHaveLength(6);
    expect(parsed.items[0].title).toBe("Hello's World");
    expect(parsed.items[0].comments.map(comment => comment.oldId)).toEqual([100, 101]);
  });

  it('remaps posts, pages, notes, comments, terms, media and relationships', () => {
    const dataset = buildWordPressMigrationDataset(parseWordPressExport(WXR), TARGET, {
      authorId: 1,
      includeAttachments: true,
      siteUrl: 'https://new.example',
      rewriteMedia: true,
    });

    expect(dataset.contents).toHaveLength(6);
    expect(dataset.skipped).toEqual({});
    expect(dataset.contents[0]).toMatchObject({ cid: 41, slug: 'hello-wp-10', type: 'post', commentsNum: 2 });
    expect(dataset.contents[1]).toMatchObject({ cid: 42, type: 'post_draft', status: 'draft' });
    expect(dataset.contents[2]).toMatchObject({
      cid: 43, slug: 'about', type: 'page', status: 'publish', parent: 0, order: 2,
      password: 'page-password', allowComment: '1', allowFeed: '0', commentsNum: 1,
    });
    expect(dataset.contents[3]).toMatchObject({ cid: 44, slug: 'team', type: 'page_draft', status: 'draft', parent: 43, order: 5 });
    expect(dataset.contents[4]).toMatchObject({ cid: 45, slug: 'note-20', type: 'note', status: 'private', allowComment: '0' });
    expect(dataset.contents[5]).toMatchObject({ cid: 46, type: 'attachment', parent: 43 });
    expect(String(dataset.contents[0].text)).toContain('https://new.example/usr/uploads/2024/01/a.jpg');
    expect(dataset.comments.map(comment => comment.coid)).toEqual([201, 202, 203]);
    expect(dataset.comments[1].parent).toBe(201);
    expect(dataset.comments[2]).toMatchObject({ cid: 43, text: 'Page comment', status: 'approved' });
    expect(dataset.relationships).toContainEqual({ cid: 41, mid: 5 });
    expect(dataset.fields).toContainEqual(expect.objectContaining({ cid: 45, name: 'note_likes', int_value: 7 }));
    expect(dataset.fields).toContainEqual(expect.objectContaining({ cid: 45, name: 'note_attachments', str_value: '[46]' }));
    expect(dataset.fields).toContainEqual(expect.objectContaining({ cid: 41, name: 'featured_attachment', int_value: 46 }));
    expect(dataset.fields).toContainEqual(expect.objectContaining({ cid: 43, name: 'featured_attachment', int_value: 46 }));
    expect(dataset.fields).toContainEqual(expect.objectContaining({
      cid: 41,
      name: 'wordpress:_wp_old_slug',
      str_value: '["old-one","old-two"]',
    }));
    expect(dataset.mediaAssets).toEqual([expect.objectContaining({ key: 'usr/uploads/2024/01/a.jpg' })]);
  });

  it('always imports notes without changing plugin configuration', () => {
    const dataset = buildWordPressMigrationDataset(parseWordPressExport(WXR), TARGET, {
      authorId: 1,
      includeAttachments: true,
      siteUrl: '',
      rewriteMedia: false,
    });
    expect(dataset.mediaAssets).toEqual([]);
    expect(String(dataset.contents[0].text)).toContain('https://old.example/wp-content/uploads/2024/01/a.jpg');
    expect(dataset.contents).toContainEqual(expect.objectContaining({ type: 'note' }));
    expect(dataset.imported.notes).toBe(1);
    expect(buildWordPressMigrationStatements(dataset).join('\n')).not.toContain('activatedPlugins');
  });

  it('retains original URLs for media objects that could not be transferred', () => {
    const dataset = buildWordPressMigrationDataset(parseWordPressExport(WXR), TARGET, {
      authorId: 1,
      includeAttachments: true,
      siteUrl: 'https://new.example',
      rewriteMedia: true,
      skipMediaKeys: new Set(['usr/uploads/2024/01/a.jpg']),
    });

    const attachment = dataset.contents.find(content => content.type === 'attachment')!;
    expect(String(dataset.contents[0].text)).toContain('https://old.example/wp-content/uploads/2024/01/a.jpg');
    expect(dataset.mediaAssets).toEqual([]);
    expect(dataset.imported.media).toBe(0);
    expect(JSON.parse(String(attachment.text))).toMatchObject({
      path: '',
      url: 'https://old.example/wp-content/uploads/2024/01/a.jpg',
    });
  });

  it('retries failed media transfers three times and returns a non-fatal failure', async () => {
    const transfer = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const wait = vi.fn().mockResolvedValue(undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const asset = {
      sourceUrl: 'https://old.example/wp-content/uploads/2024/01/a.jpg',
      key: 'usr/uploads/2024/01/a.jpg',
      targetUrl: 'https://new.example/usr/uploads/2024/01/a.jpg',
    };

    try {
      await expect(transferMediaWithRetries(asset, transfer, wait)).resolves.toEqual({
        sourceUrl: asset.sourceUrl,
        key: asset.key,
        attempts: MEDIA_TRANSFER_RETRY_COUNT + 1,
        error: 'fetch failed',
      });
      expect(transfer).toHaveBeenCalledTimes(MEDIA_TRANSFER_RETRY_COUNT + 1);
      expect(wait).toHaveBeenCalledWith(1_000);
      expect(wait).toHaveBeenCalledWith(2_000);
      expect(wait).toHaveBeenCalledWith(4_000);
    } finally {
      warning.mockRestore();
    }
  });

  it('stops retrying as soon as a media transfer succeeds', async () => {
    const transfer = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(transferMediaWithRetries({ sourceUrl: 'https://old.example/a.jpg', key: 'a.jpg', targetUrl: 'https://new.example/a.jpg' }, transfer, wait)).resolves.toBeNull();
      expect(transfer).toHaveBeenCalledTimes(2);
      expect(wait).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it('preserves WordPress content and comment IDs when overriding', () => {
    const dataset = buildWordPressMigrationDataset(
      parseWordPressExport(WXR),
      buildWordPressOverrideTargetState(TARGET),
      {
        authorId: 1,
        includeAttachments: true,
        siteUrl: '',
        rewriteMedia: false,
        preserveIds: true,
      },
    );

    expect(dataset.contents.map(content => content.cid)).toEqual([10, 11, 40, 41, 20, 30]);
    expect(dataset.contents.find(content => content.cid === 20)).toMatchObject({ type: 'note' });
    expect(dataset.contents.find(content => content.cid === 41)).toMatchObject({ parent: 40 });
    expect(dataset.comments.map(comment => comment.coid)).toEqual([100, 101, 102]);
    expect(dataset.comments[1]).toMatchObject({ cid: 10, parent: 100 });
    expect(dataset.comments[2]).toMatchObject({ cid: 40, parent: 0 });
    expect(dataset.fields).toContainEqual(expect.objectContaining({ cid: 20, name: 'note_attachments', str_value: '[30]' }));
    expect(dataset.fields).toContainEqual(expect.objectContaining({ cid: 10, name: 'featured_attachment', int_value: 30 }));
  });

  it('generates escaped SQL and topic recount statements', () => {
    expect(sqlLiteral("Hello's")).toBe("'Hello''s'");
    expect(sqlLiteral(`CSS${String.fromCharCode(0)}hack`)).toBe("CAST(X'435353006861636b' AS TEXT)");
    const dataset = buildWordPressMigrationDataset(parseWordPressExport(WXR), TARGET, {
      authorId: 1,
      includeAttachments: false,
      siteUrl: '',
      rewriteMedia: false,
    });
    const sql = buildWordPressMigrationStatements(dataset).join('\n');
    expect(sql).toContain("Hello''s World");
    expect(sql).toContain('UPDATE typecho_metas SET "count"');
  });

  it('accepts bun run argument separators', () => {
    expect(parseWordPressMigrationArgs(['--', '--source', import.meta.filename, '--dry-run'])).toMatchObject({
      source: import.meta.filename,
      dryRun: true,
      d1Name: 'typecho-db',
      r2Bucket: 'typecho-uploads',
    });
    expect(() => parseWordPressMigrationArgs(['--source', import.meta.filename, '--skip-notes']))
      .toThrow('Unknown option: --skip-notes');
    expect(() => parseWordPressMigrationArgs(['--source', import.meta.filename, '--no-activate-notes']))
      .toThrow('Unknown option: --no-activate-notes');
  });

  it('requires an explicit boolean override value and resets the content import state', () => {
    expect(parseWordPressMigrationArgs(['--source', import.meta.filename, '--override', 'true'])).toMatchObject({
      override: true,
    });
    expect(() => parseWordPressMigrationArgs(['--source', import.meta.filename, '--override', 'yes']))
      .toThrow('--override must be true or false');
    expect(buildWordPressOverrideTargetState(TARGET)).toMatchObject({
      maxContentId: 0,
      maxCommentId: 0,
      maxMetaId: TARGET.maxMetaId,
      contentSlugs: [],
      metas: TARGET.metas,
    });
    expect(buildWordPressOverrideStatements()).toEqual([
      'DELETE FROM typecho_comments;',
      'DELETE FROM typecho_relationships;',
      'DELETE FROM typecho_fields;',
      'DELETE FROM typecho_contents;',
      "DELETE FROM sqlite_sequence WHERE name IN ('typecho_contents', 'typecho_comments');",
      'UPDATE typecho_metas SET "count" = 0;',
    ]);
  });
});

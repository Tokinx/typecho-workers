/**
 * Comment email notification logic.
 *
 * Triggered after a comment is saved and approved. Sends two emails
 * (best-effort, via waitUntil): one to the post author, one to the
 * parent comment author (if applicable).
 */

import type { Database } from '@/db';
import { schema } from '@/db';
import { sendMail, isValidEmail, type MailResult } from '@/lib/mail';
import type { HookContext } from '@/lib/plugin';
import { buildPermalink } from '@/lib/content';
import { escapeHtml } from '@/lib/escape';
import { eq } from 'drizzle-orm';

export interface NotifyCommentConfig {
  pluginCtx: HookContext;
  db: Database;
  options: Record<string, unknown>;
  siteUrl: string;
  permalinkPattern?: string;
  pagePattern?: string;
  comment: {
    coid: number;
    cid: number;
    author: string | null;
    mail: string | null;
    text: string | null;
    parent: number;
    authorId?: number | null;
  };
  content: {
    cid: number;
    title: string | null;
    slug: string | null;
    type: string;
    created: number;
    authorId: number | null;
  };
  request?: Request;
}

export async function notifyOnComment(cfg: NotifyCommentConfig): Promise<void> {
  if (Number(cfg.options.commentEmailEnabled) !== 1) return;

  const url = buildPermalink(cfg.content, cfg.siteUrl, cfg.permalinkPattern, cfg.pagePattern);
  const commentUrl = `${url}#comment-${cfg.comment.coid}`;

  const author = cfg.content.authorId
    ? await cfg.db.query.users.findFirst({
        where: eq(schema.users.uid, cfg.content.authorId),
        columns: { uid: true, mail: true, screenName: true, name: true },
      })
    : null;

  const promises: Promise<MailResult>[] = [];
  const sentTo = new Set<string>();

  // Notify post author
  if (
    author?.mail &&
    isValidEmail(author.mail) &&
    author.uid !== (cfg.comment.authorId || 0)
  ) {
    sentTo.add(author.mail);
    promises.push(
      sendMail(
        cfg.pluginCtx,
        {
          to: author.mail,
          subject: `[${cfg.options.title}] 新的评论 on 《${cfg.content.title}》`,
          html: `<p>${cfg.comment.author || '匿名'} 在你的文章<a href="${commentUrl}">《${escapeHtml(cfg.content.title || '')}》</a>中发表了评论：</p><blockquote>${escapeHtml(cfg.comment.text || '')}</blockquote><p><a href="${commentUrl}">查看评论</a></p>`,
          text: `${cfg.comment.author || '匿名'} 在你的文章《${cfg.content.title}》中发表了评论。\n\n${cfg.comment.text}\n\n查看：${commentUrl}`,
        },
        { request: cfg.request, options: cfg.options, reason: 'comment' },
      ),
    );
  }

  // Notify parent comment author (reply notification)
  if (cfg.comment.parent && Number(cfg.options.commentEmailReplyEnabled ?? 1) === 1) {
    const parent = await cfg.db.query.comments.findFirst({
      where: eq(schema.comments.coid, cfg.comment.parent),
      columns: { mail: true, author: true },
    });
    if (
      parent?.mail &&
      isValidEmail(parent.mail) &&
      parent.mail !== cfg.comment.mail &&
      !sentTo.has(parent.mail)
    ) {
      promises.push(
        sendMail(
          cfg.pluginCtx,
          {
            to: parent.mail,
            subject: `[${cfg.options.title}] 你的评论有新回复`,
            html: `<p>${cfg.comment.author || '匿名'} 回复了你在<a href="${commentUrl}">《${escapeHtml(cfg.content.title || '')}》</a>中的评论：</p><blockquote>${escapeHtml(cfg.comment.text || '')}</blockquote><p><a href="${commentUrl}">查看回复</a></p>`,
            text: `${cfg.comment.author || '匿名'} 回复了你在《${cfg.content.title}》中的评论。\n\n${cfg.comment.text}\n\n查看：${commentUrl}`,
          },
          { request: cfg.request, options: cfg.options, reason: 'comment-reply' },
        ),
      );
    }
  }

  await Promise.allSettled(promises);
}

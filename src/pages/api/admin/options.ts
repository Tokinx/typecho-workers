import type { APIRoute } from 'astro';
import { setOption } from '@/lib/options';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { bumpCacheVersion, purgeSiteCache } from '@/lib/cache';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) return auth;

  const formData = await request.formData();

  // Save each option
  const optionKeys = [
    'title', 'description', 'keywords', 'siteUrl', 'timezone',
    'allowRegister', 'allowXmlRpc', 'pageSize', 'postsListSize', 'commentsListSize',
    'defaultAllowComment', 'defaultAllowPing', 'defaultAllowFeed',
    'feedFullText', 'markdown', 'postDateFormat', 'commentDateFormat',
    'commentsRequireMail', 'commentsRequireURL', 'commentsRequireModeration',
    'commentsWhitelist', 'commentsMaxNestingLevels',
    'commentsUrlNofollow', 'commentsShowUrl', 'commentsMarkdown',
    'commentsPageBreak', 'commentsThreaded', 'commentsPageSize',
    'commentsPageDisplay', 'commentsOrder', 'commentsCheckReferer',
      'commentsAutoClose', 'commentsPostIntervalEnable',
      'commentsAntiSpam', 'commentsHTMLTagAllowed', 'commentsAvatar',
      'commentsAvatarRating', 'commentsShowCommentOnly',
    'frontArchive', 'cacheEnabled',
    'loginFailBanEnabled', 'loginFailBanWindowSeconds',
    'loginFailBanMaxFailures', 'loginFailBanSeconds',
    'feedItems', 'robotsTxt',
    'mailEnabled', 'mailFrom', 'mailFromName',
    'commentEmailEnabled', 'commentEmailReplyEnabled',
  ];

  // Handle permalinkPattern specially: if "custom" is selected, use customPattern value
  const permalinkValue = formData.get('permalinkPattern');
  if (permalinkValue !== null) {
    let pattern = permalinkValue.toString();
    if (pattern === 'custom') {
      const customPattern = formData.get('customPattern');
      pattern = customPattern?.toString().trim() || '/archives/{cid}/';
    }
    await setOption(auth.db, 'permalinkPattern', pattern);
  }

  // The reading page uses a radio value plus a page selector, while the
  // public renderer stores the selected page as `page:<cid>`.
  const frontPageValue = formData.get('frontPage');
  if (frontPageValue !== null) {
    const frontPage = frontPageValue.toString() === 'page'
      ? `page:${Math.max(0, Number.parseInt(formData.get('frontPagePage')?.toString() || '0', 10) || 0)}`
      : 'recent';
    await setOption(auth.db, 'frontPage', frontPage === 'page:0' ? 'recent' : frontPage);
  }

  // Handle pagePattern — direct text input, save as-is
  const pagePatternValue = formData.get('pagePattern');
  if (pagePatternValue !== null) {
    const pattern = pagePatternValue.toString().trim() || '/{slug}.html';
    await setOption(auth.db, 'pagePattern', pattern);
  }

  // Handle categoryPattern — direct text input, save as-is
  const categoryPatternValue = formData.get('categoryPattern');
  if (categoryPatternValue !== null) {
    const pattern = categoryPatternValue.toString().trim() || '/category/{slug}/';
    await setOption(auth.db, 'categoryPattern', pattern);
  }

  for (const key of optionKeys) {
    const value = formData.get(key);
    if (value !== null) {
      await setOption(auth.db, key, value.toString());
    }
  }

  // Typecho's discussion form uses `commentsRequireUrl`; the application
  // option keeps its historical uppercase `URL` spelling.
  const commentsRequireUrlValue = formData.get('commentsRequireUrl');
  if (commentsRequireUrlValue !== null) {
    await setOption(auth.db, 'commentsRequireURL', commentsRequireUrlValue.toString());
  }

  const nestingLevelsValue = formData.get('commentsMaxNestingLevels');
  if (nestingLevelsValue !== null) {
    const parsedNestingLevels = Number.parseInt(nestingLevelsValue.toString(), 10);
    const nestingLevels = Number.isFinite(parsedNestingLevels)
      ? Math.min(7, Math.max(2, parsedNestingLevels))
      : 5;
    await setOption(auth.db, 'commentsMaxNestingLevels', String(nestingLevels));
  }

  // Handle commentsPostTimeout: form sends days, store as seconds (Typecho convention)
  const postTimeoutDays = formData.get('commentsPostTimeout');
  if (postTimeoutDays !== null) {
    const days = parseInt(postTimeoutDays.toString(), 10) || 14;
    await setOption(auth.db, 'commentsPostTimeout', String(days * 24 * 3600));
  }

  // Handle commentsPostInterval: form sends minutes, store as seconds (Typecho convention)
  const postIntervalMinutes = formData.get('commentsPostInterval');
  if (postIntervalMinutes !== null) {
    const minutes = parseInt(postIntervalMinutes.toString(), 10) || 1;
    await setOption(auth.db, 'commentsPostInterval', String(minutes * 60));
  }

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    '/admin/options-general',
  );

  // Handle checkbox fields that may not be present (unchecked checkboxes aren't sent in form data)
  // IMPORTANT: Only process checkboxes belonging to the current page to avoid
  // clearing checkboxes from other settings pages (each page submits to this same endpoint)
  const refererPath = referer.split('?')[0];

  // Typecho stores upload groups and custom extensions as one comma-separated
  // option. Keep custom extension values readable by the upload validator.
  if (refererPath.startsWith('/admin/options-general')) {
    const selectedTypeValues = formData.getAll('attachmentTypes[]');
    const selectedValues = selectedTypeValues.length > 0 ? selectedTypeValues : formData.getAll('attachmentTypes');
    const selectedTypes = selectedValues
      .map((value) => value.toString())
      .filter((value) => ['@image@', '@media@', '@doc@'].includes(value));
    const customTypes = formData.get('attachmentTypesOther')?.toString() || '';
    const customExtensions = customTypes.split(/[,.]/)
      .map((value) => value.trim().replace(/^\./, '').toLowerCase())
      .filter((value) => selectedValues.some((selected) => selected.toString() === '@other@'))
      .filter((value) => /^[a-z0-9][a-z0-9_-]{0,15}$/.test(value));
    await setOption(auth.db, 'attachmentTypes', [...selectedTypes, ...customExtensions].join(','));
  }

  const checkboxFieldsByPage: Record<string, string[]> = {
    '/admin/options-general': [
      'allowRegister', 'cacheEnabled',
    ],
    '/admin/options-discussion': [
      'commentsShowCommentOnly', 'commentsAvatar', 'commentsShowUrl',
      'commentsMarkdown', 'commentsUrlNofollow',
      'commentsRequireMail', 'commentsRequireURL', 'commentsCheckReferer', 'commentsAntiSpam',
      'commentsRequireModeration', 'commentsWhitelist', 'commentsAutoClose',
      'commentsThreaded', 'commentsPageBreak', 'commentsPostIntervalEnable',
      'mailEnabled',
      'commentEmailEnabled', 'commentEmailReplyEnabled',
    ],
    '/admin/options-reading': [
      'feedFullText',
    ],
  };

  // Determine which page this submission came from
  const pageCheckboxes = Object.entries(checkboxFieldsByPage)
    .find(([page]) => refererPath.startsWith(page));
  
  if (pageCheckboxes) {
    for (const key of pageCheckboxes[1]) {
      const legacyAliasPresent = key === 'commentsRequireURL' && formData.has('commentsRequireUrl');
      if (!formData.has(key) && !legacyAliasPresent) {
        await setOption(auth.db, key, '0');
      }
    }
  }

  await bumpCacheVersion(auth.db);
  await purgeSiteCache(auth.options.siteUrl || '');

  return new Response(null, {
    status: 302,
    headers: { Location: referer },
  });
};

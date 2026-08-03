import { hasPermission, registerPluginAdminPath } from 'typecho/plugin-sdk';
import type { PluginInitContext, PluginRouteResult } from 'typecho/plugin-sdk';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { jsonError } from '@/lib/http';
import { notesAdminPageHtml } from './admin';
import { handleNotesRequest, NOTE_TYPE } from './service';

export {
  extractTopicNames,
  getNoteForTheme,
  getNotesForTheme,
  handleNotesRequest,
  normalizeNoteInput,
  renderNoteContent,
  topicSlug,
  NOTE_REFERENCE_PATTERN,
  NOTE_TYPE,
  NOTE_TOPIC_TYPE,
} from './service';
export type {
  NoteListItem,
  NotesListResult,
  NotesThemeVariables,
  NoteTopic,
  ThemeNotesOptions,
  ThemeNotesQuery,
} from './service';
export { notesAdminPageHtml } from './admin';

export const NOTES_ADMIN_API_PATH = '/api/admin/notes';

export default function init({ addHook, pluginId }: PluginInitContext): void {
  registerPluginAdminPath(NOTES_ADMIN_API_PATH);

  addHook(
    'route:request',
    pluginId,
    async (result: PluginRouteResult, extra?: { request?: Request; path?: string }) => {
      if (result?.handled || !extra?.request || extra.path !== NOTES_ADMIN_API_PATH) return result;
      const request = extra.request;
      const auth = await requireAdminAction(request, 'administrator', { csrf: request.method !== 'GET' });
      if (isAdminActionResponse(auth)) {
        return {
          handled: true,
          response: jsonError(auth.status, auth.status === 401 ? 'Unauthorized' : 'Forbidden'),
        };
      }
      return {
        handled: true,
        response: await handleNotesRequest(request, {
          db: auth.db,
          uid: auth.uid,
          user: auth.user,
          options: auth.options,
        }),
      };
    },
    20,
  );

  addHook(
    'comment:allowContent',
    pluginId,
    (allowed: boolean, extra?: { content?: { type?: string | null; status?: string | null; created?: number | null; allowComment?: string | null } }) => {
      const content = extra?.content;
      if (content?.type !== NOTE_TYPE) return allowed;
      return content.status === 'publish' &&
        content.allowComment === '1' &&
        (content.created || 0) <= Math.floor(Date.now() / 1000);
    },
  );

  addHook(
    'admin:page',
    pluginId,
    (html: string, extra?: { slug?: string; csrfToken?: string }) => {
      if (extra?.slug !== 'notes') return html;
      return notesAdminPageHtml(extra.csrfToken || '');
    },
  );

  addHook(
    'admin:footer',
    pluginId,
    (html: string, extra?: { activeMenu?: string; user?: { group?: string } }) => {
      const isAdmin = extra?.user?.group && hasPermission(extra.user.group, 'administrator');
      if (!isAdmin) return html;
      const active = extra?.activeMenu === 'notes';
      return html + `<script>
(function(){
  function insertAfter(rootIndex, afterHref, href, label, focused){
    var root=document.querySelector('.typecho-head-nav nav > menu > li:nth-child('+rootIndex+')');
    if(!root)return;
    var anchor=root.querySelector(':scope > menu a[href="'+afterHref+'"]');
    if(!anchor||!anchor.parentElement)return;
    var item=document.createElement('li');
    item.className=focused?'focus':'';
    item.innerHTML='<a href="'+href+'">'+label+'</a>';
    anchor.parentElement.insertAdjacentElement('afterend',item);
    if(focused)root.classList.add('focus');
  }
  insertAfter(2,'/admin/write-post','/admin/plugin/notes','撰写笔记',false);
  insertAfter(3,'/admin/manage-posts','/admin/plugin/notes','笔记',${active ? 'true' : 'false'});
})();
</script>`;
    },
  );
}

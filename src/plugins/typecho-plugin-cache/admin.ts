import type { PublicCacheDomain } from '@/lib/cache';

const DOMAIN_LABELS: Array<[PublicCacheDomain | 'all', string]> = [
  ['home', '刷新首页'],
  ['post', '刷新文章'],
  ['page', '刷新页面'],
  ['note', '刷新笔记'],
  ['archive', '刷新归档'],
  ['other', '刷新其他页面'],
  ['all', '刷新全部'],
];

export function cacheAdminPageHtml(csrfToken: string, bindingAvailable: boolean): string {
  const buttons = DOMAIN_LABELS.map(([domain, label]) =>
    `<button type="button" class="btn${domain === 'all' ? ' primary' : ''}" data-cache-domain="${domain}">${label}</button>`
  ).join(' ');
  const status = bindingAvailable
    ? '<span class="cache-status available">TYPECHO_CACHE 已连接</span>'
    : '<span class="cache-status unavailable">未检测到 TYPECHO_CACHE binding</span>';
  return `<section id="edge-cache-app">
  <p>${status}</p>
  <div class="cache-actions">${buttons}</div>
  <p id="cache-result" role="status" aria-live="polite"></p>
</section>
<style>
#edge-cache-app{max-width:760px}.cache-status{display:inline-block;padding:4px 8px;border-radius:3px}.cache-status.available{background:#edf7ed;color:#246b2d}.cache-status.unavailable{background:#fff1f0;color:#9f2f29}.cache-actions{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0}#cache-result{min-height:24px}
</style>
<script>
(function(){
  var root=document.getElementById('edge-cache-app'),result=document.getElementById('cache-result');
  if(!root||!result)return;
  root.addEventListener('click',async function(event){
    var button=event.target.closest('[data-cache-domain]');
    if(!button)return;
    button.disabled=true;result.textContent='正在刷新...';
    try{
      var response=await fetch('/api/admin/plugin-action',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':${JSON.stringify(csrfToken)}},body:JSON.stringify({plugin:'typecho-plugin-cache',action:'invalidate',payload:{domain:button.dataset.cacheDomain}})});
      var data=await response.json();if(!response.ok)throw new Error(data.error||'刷新失败');result.textContent=data.message||'缓存已失效';
    }catch(error){result.textContent=error.message||'刷新失败'}finally{button.disabled=false}
  });
})();
</script>`;
}

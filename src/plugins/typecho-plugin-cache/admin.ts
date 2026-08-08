import type { PublicCacheDomain } from '@/lib/cache';

const DOMAIN_LABELS: Array<[PublicCacheDomain, string]> = [
  ['home', '首页'],
  ['post', '文章'],
  ['page', '页面'],
  ['note', '笔记'],
  ['archive', '归档'],
  ['other', '其他页面'],
];

export function cacheAdminPageHtml(csrfToken: string, bindingAvailable: boolean): string {
  const checkboxes = DOMAIN_LABELS.map(([domain, label]) =>
    `<label class="cache-scope"><input type="checkbox" value="${domain}" data-cache-domain="${domain}"><span>${label}</span></label>`
  ).join('');
  const status = bindingAvailable
    ? '<span class="cache-status available">TYPECHO_CACHE 已连接</span>'
    : '<span class="cache-status unavailable">未检测到 TYPECHO_CACHE binding</span>';
  return `<section id="edge-cache-app" class="col-mb-12">
  <p>${status}</p>
  <div class="cache-scopes" role="group" aria-label="选择要刷新的缓存">${checkboxes}</div>
  <div class="cache-actions">
    <button type="button" class="btn primary" id="cache-refresh-btn" disabled>刷新</button>
    <button type="button" class="btn" id="cache-refresh-all">刷新全部缓存</button>
  </div>
  <p id="cache-result" role="status" aria-live="polite"></p>
</section>
<style>
#edge-cache-app{max-width:760px}.cache-status{display:inline-block;padding:4px 8px;border-radius:3px}.cache-status.available{background:#edf7ed;color:#246b2d}.cache-status.unavailable{background:#fff1f0;color:#9f2f29}.cache-scopes{display:flex;flex-wrap:wrap;gap:10px 16px;margin:20px 0 10px}.cache-scope{display:inline-flex;align-items:center;gap:5px;font-size:13px;color:#333;cursor:pointer;user-select:none}.cache-actions{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}#cache-refresh-btn{color:#fff !important}#cache-refresh-btn[disabled]{opacity:.5;cursor:default}#cache-result{min-height:24px}
</style>
<script>
(function(){
  var root=document.getElementById('edge-cache-app'),result=document.getElementById('cache-result'),refreshBtn=document.getElementById('cache-refresh-btn'),allBtn=document.getElementById('cache-refresh-all');
  if(!root||!result||!refreshBtn||!allBtn)return;
  var scopes=Array.prototype.slice.call(root.querySelectorAll('[data-cache-domain]'));
  function updateState(){refreshBtn.disabled=scopes.every(function(input){return !input.checked})}
  scopes.forEach(function(input){input.addEventListener('change',updateState)});
  async function refresh(domains){
    var label=domains==='all'?'全部缓存':domains.length+' 个缓存域';
    refreshBtn.disabled=true;allBtn.disabled=true;result.textContent='正在刷新'+label+'...';
    try{
      var response=await fetch('/api/admin/plugin-action',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':${JSON.stringify(csrfToken)}},body:JSON.stringify({plugin:'typecho-plugin-cache',action:'invalidate',payload:{domains:domains}})});
      var data=await response.json();if(!response.ok)throw new Error(data.error||'刷新失败');result.textContent=data.message||label+'已失效';
    }catch(error){result.textContent=error.message||'刷新失败'}finally{refreshBtn.disabled=scopes.every(function(input){return !input.checked});allBtn.disabled=false}
  }
  refreshBtn.addEventListener('click',function(){
    var domains=scopes.filter(function(input){return input.checked}).map(function(input){return input.value});
    if(domains.length===0)return;refresh(domains);
  });
  allBtn.addEventListener('click',function(){refresh('all')});
})();
</script>`;
}

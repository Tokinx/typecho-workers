import type { CachePluginConfig } from './cache';

const DOMAIN_LABELS: Array<[string, string]> = [
  ['home', '首页'],
  ['post', '文章'],
  ['page', '页面'],
  ['note', '笔记'],
  ['archive', '归档'],
  ['other', '其他页面'],
];

export interface CacheAdminPageProps {
  csrfToken: string;
  bindingAvailable: boolean;
  config: CachePluginConfig;
  /** ISO timestamp of the last manual refresh, or null when none is recorded. */
  lastRefresh: string | null;
}

function formatTtl(seconds: number): string {
  if (seconds <= 0) return '不缓存';
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = minutes / 60;
  if (hours < 24) return hours % 1 === 0 ? `${hours} 小时` : `${hours.toFixed(1)} 小时`;
  const days = hours / 24;
  return days % 1 === 0 ? `${days} 天` : `${days.toFixed(1)} 天`;
}

function backendLabel(backend: CachePluginConfig['frontendDataCacheBackend']): string {
  return backend === 'kv' ? 'KV' : backend === 'd1' ? 'D1' : '不缓存';
}

export function cacheAdminPageHtml(props: CacheAdminPageProps): string {
  const { csrfToken, bindingAvailable, config, lastRefresh } = props;
  const domainCheckboxes = DOMAIN_LABELS.map(([domain, label]) =>
    `<label class="cache-scope"><input type="checkbox" value="${domain}" data-cache-domain="${domain}"><span>${label}</span></label>`
  ).join('');
  const status = bindingAvailable
    ? '<span class="cache-status available">TYPECHO_CACHE 已连接</span>'
    : '<span class="cache-status unavailable">未检测到 TYPECHO_CACHE binding</span>';
  const summary = [
    `页面缓存 L1 ${formatTtl(config.l1Ttl)} / L2 ${formatTtl(config.l2Ttl)} / L3 ${formatTtl(config.l3Ttl)}`,
    `前台数据 ${backendLabel(config.frontendDataCacheBackend)}`,
    `后台数据 ${backendLabel(config.adminDataCacheBackend)}`,
  ].join(' · ');
  const lastRefreshHtml = lastRefresh
    ? `<span data-ec-last-refresh="${lastRefresh}"></span>`
    : '<span>暂无记录</span>';
  return `<section id="edge-cache-app">
  <p class="ec-status-line">${status}<span class="ec-summary">${summary} · 上次手动刷新: ${lastRefreshHtml}</span></p>
  <h3 class="ec-module-title">快捷刷新</h3>
  <div class="ec-module ec-scene-grid" role="group" aria-label="按场景刷新缓存">
    <div class="ec-action">
      <button type="button" class="btn primary" id="ec-quick-frontend">前台立即更新</button>
      <span class="ec-hint">前台页面缓存与前台数据缓存</span>
    </div>
    <div class="ec-action">
      <button type="button" class="btn" id="ec-quick-admin">后台立即更新</button>
      <span class="ec-hint">仅后台数据缓存</span>
    </div>
    <div class="ec-action">
      <button type="button" class="btn" id="ec-quick-all">全部刷新</button>
      <span class="ec-hint">全部页面缓存和全部数据缓存</span>
    </div>
  </div>
  <h3 class="ec-module-title">按需刷新</h3>
  <div class="ec-module">
    <div class="ec-scope-group">
      <div class="ec-scope-label">页面缓存</div>
      <div class="cache-scopes" role="group" aria-label="选择要刷新的 HTML 缓存域">${domainCheckboxes}</div>
    </div>
    <div class="ec-scope-group">
      <div class="ec-scope-label">数据缓存</div>
      <div class="cache-scopes" role="group" aria-label="选择要刷新的数据缓存组">
        <label class="cache-scope"><input type="checkbox" value="frontend" data-cache-data="frontend"><span>前台数据缓存</span></label>
        <label class="cache-scope"><input type="checkbox" value="admin" data-cache-data="admin"><span>后台数据缓存</span></label>
      </div>
    </div>
    <button type="button" class="btn primary" id="cache-refresh-btn" disabled>刷新所选</button>
  </div>
  <h3 class="ec-module-title">维护</h3>
  <div class="ec-module ec-action">
    <button type="button" class="btn" id="ec-compact-btn">清理过期缓存</button>
    <span class="ec-hint">删除 D1 缓存表中已过期的缓存数据，释放数据库存储空间；KV 与 L1 的旧条目无法主动删除，仅随 TTL 过期</span>
  </div>
  <p id="cache-result" role="status" aria-live="polite"></p>
</section>
<style>
.cache-status{display:inline-block;padding:4px 8px;border-radius:3px}.cache-status.available{background:#edf7ed;color:#246b2b}.cache-status.unavailable{background:#fff1f0;color:#9f2f29}.ec-status-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:14px 0 0}.ec-summary{font-size:12px;color:#666}.ec-module-title{font-size:14px;font-weight:600;color:#333;margin:16px 0 8px}.ec-module{border:1px solid #e5e5e5;border-radius:3px;padding:12px 16px;margin:0 0 6px;background:#fafafa}.ec-module.ec-scene-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}.ec-action{display:flex;flex-direction:column;align-items:flex-start;gap:6px}.ec-module.ec-quick{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}.ec-hint{font-size:12px;color:#888}.ec-scope-group{margin:0 0 12px}.ec-scope-label{font-size:13px;font-weight:600;color:#555;margin:0 0 4px}.cache-scopes{display:flex;flex-wrap:wrap;gap:10px 16px;margin:0}.cache-scope{display:inline-flex;align-items:center;gap:5px;font-size:13px;color:#333;cursor:pointer;user-select:none}#cache-refresh-btn{color:#fff !important}#cache-refresh-btn[disabled]{opacity:.5;cursor:default}#cache-result{min-height:24px;margin-top:10px}
</style>
<script>
(function(){
  var root=document.getElementById('edge-cache-app'),result=document.getElementById('cache-result');
  if(!root||!result)return;
  var domainInputs=Array.prototype.slice.call(root.querySelectorAll('[data-cache-domain]'));
  var dataInputs=Array.prototype.slice.call(root.querySelectorAll('[data-cache-data]'));
  var refreshBtn=document.getElementById('cache-refresh-btn');
  if(!refreshBtn)return;
  var buttons=Array.prototype.slice.call(root.querySelectorAll('button'));
  function anySelected(){return domainInputs.some(function(input){return input.checked})||dataInputs.some(function(input){return input.checked})}
  function setBusy(busy){buttons.forEach(function(button){button.disabled=busy});if(!busy)refreshBtn.disabled=!anySelected()}
  function renderGroups(groups){
    var parts=[];
    if(groups){
      var html=groups.html||[];
      if(html.length>0)parts.push(html[0]==='all'?'前台 HTML（全部域）✓':'前台 HTML（'+html.length+' 个域）✓');
      var data=groups.data||[];
      if(data.length>0)parts.push(data[0]==='all'?'全部数据缓存 ✓':data.map(function(group){return group==='frontend'?'前台数据缓存 ✓':'后台数据缓存 ✓'}).join('、'));
    }
    return parts;
  }
  async function post(message,action,payload){
    result.textContent='正在'+message+'...';
    setBusy(true);
    try{
      var response=await fetch('/api/admin/plugin-action',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':${JSON.stringify(csrfToken)}},body:JSON.stringify({plugin:'typecho-plugin-cache',action:action,payload:payload})});
      var data=await response.json();
      if(!response.ok)throw new Error(data.error||'操作失败');
      if(data.success===false)throw new Error(data.error||'操作失败');
      var parts=renderGroups(data.groups);
      result.textContent=parts.length?parts.join('；')+' 完成':(data.message||'完成');
      if(data.compacted!==undefined)result.textContent=data.message||('已清理 '+data.compacted+' 行');
      return data;
    }catch(error){
      result.textContent=error.message||'操作失败';
    }finally{
      setBusy(false);
      var stamp=document.querySelector('[data-ec-last-refresh]');
      if(stamp&&action==='invalidate')stamp.textContent=new Date().toLocaleString();
    }
  }
  function invalidatePrompt(message,payload){
    var confirmed=window.confirm('将推倒全部页面缓存与前后台数据缓存，下次访问重新生成。确认继续？');
    if(!confirmed)return;
    post(message,'invalidate',payload);
  }
  refreshBtn.addEventListener('click',function(){
    var domains=domainInputs.filter(function(input){return input.checked}).map(function(input){return input.value});
    var data=dataInputs.filter(function(input){return input.checked}).map(function(input){return input.value});
    if(domains.length===0&&data.length===0)return;
    post('刷新所选','invalidate',{domains:domains,data:data});
  });
  document.getElementById('ec-quick-frontend').addEventListener('click',function(){post('刷新前台','invalidate',{domains:['all'],data:['frontend']})});
  document.getElementById('ec-quick-admin').addEventListener('click',function(){post('刷新后台','invalidate',{domains:[],data:['admin']})});
  document.getElementById('ec-quick-all').addEventListener('click',function(){invalidatePrompt('刷新全部','invalidate',{domains:['all'],data:['all']})});
  document.getElementById('ec-compact-btn').addEventListener('click',function(){post('清理过期行','compact',{})});
  refreshBtn.disabled=!anySelected();
  Array.prototype.forEach.call([].concat(domainInputs,dataInputs),function(input){input.addEventListener('change',function(){refreshBtn.disabled=!anySelected()})});
  var stamp=document.querySelector('[data-ec-last-refresh]');
  if(stamp){
    var parsed=new Date(stamp.getAttribute('data-ec-last-refresh'));
    stamp.textContent=isNaN(parsed.getTime())?'':parsed.toLocaleString();
  }
})();
</script>`;
}
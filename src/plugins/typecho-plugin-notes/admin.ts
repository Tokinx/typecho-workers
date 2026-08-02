export function notesAdminPageHtml(csrfToken: string): string {
  return `<div class="col-mb-12" id="notes-app">
  <section class="notes-main" aria-label="笔记管理">
    <div class="notes-composer" id="notes-composer">
      <div id="wmd-editarea"><textarea id="text" rows="3" maxlength="200000" placeholder="你在想什么？写下来吧。" aria-label="笔记内容"></textarea></div>
      <div id="wmd-preview" class="wmd-hidetab" aria-live="polite"></div>
      <div class="notes-composer-bar">
        <div class="editor" id="wmd-button-bar" aria-label="Markdown 编辑工具"></div>
        <input id="notes-file" type="file" accept="image/*" hidden>
        <div class="notes-publish-options">
          <select id="notes-status" aria-label="可见性"><option value="publish">公开</option><option value="private">私密</option><option value="draft">草稿</option></select>
          <button type="button" class="btn" id="notes-cancel" hidden>取消</button>
          <button type="button" class="btn primary" id="notes-send">发送</button>
        </div>
      </div>
    </div>

    <div class="notes-filterbar">
      <nav class="notes-tabs" aria-label="笔记状态">
        <button type="button" class="current" data-status="all">全部</button>
        <button type="button" data-status="publish">公开</button>
        <button type="button" data-status="private">私密</button>
        <button type="button" data-status="draft">草稿</button>
      </nav>
      <form id="notes-search-form" class="notes-search" role="search">
        <label class="sr-only" for="notes-search-input">搜索笔记</label>
        <input id="notes-search-input" class="text-s" type="search" maxlength="100" placeholder="搜索笔记" autocomplete="off">
      </form>
    </div>
    <div id="notes-notice" role="status" aria-live="polite"></div>
    <div id="notes-list" class="notes-list"><div class="notes-loading">正在加载...</div></div>
    <button type="button" class="btn notes-more" id="notes-more" hidden>加载更多</button>
  </section>

  <aside class="notes-sidebar" aria-label="话题筛选">
    <div class="notes-topic-heading"><h3>话题</h3></div>
    <div id="notes-topics" class="notes-topic-list"></div>
  </aside>
</div>
<dialog id="notes-reference-dialog" class="notes-reference-dialog" aria-labelledby="notes-reference-title"><div class="notes-reference-head"><strong id="notes-reference-title">引用笔记</strong><button type="button" class="notes-icon" id="notes-reference-close" aria-label="关闭">&times;</button></div><div id="notes-reference-body" class="notes-reference-body" aria-live="polite"></div></dialog>
<dialog id="notes-comments-dialog" class="notes-comments-dialog" aria-labelledby="notes-comments-title"><div class="notes-reference-head"><strong id="notes-comments-title">评论</strong><button type="button" class="notes-icon" id="notes-comments-close" aria-label="关闭">&times;</button></div><div class="notes-comments-body"><div id="notes-comments-list" aria-live="polite"></div><form id="notes-comment-form"><div id="notes-comment-replying" class="notes-comment-replying" hidden></div><textarea id="notes-comment-text" rows="3" maxlength="10000" required placeholder="回复评论" aria-label="回复内容"></textarea><div class="notes-comment-form-actions"><button type="button" class="btn" id="notes-comment-cancel-reply">取消回复</button><button type="submit" class="btn primary">回复</button></div></form></div></dialog>

<style>
#notes-app{display:grid;grid-template-columns:minmax(0,1fr) 230px;gap:30px;width:100%;color:#3f4b5f}
.notes-main{min-width:0}.notes-composer{border:1px solid #dfe4ec;background:#fff;overflow:hidden;border-radius:2px}
#notes-app #text{display:block;width:100%;min-height:100px;max-height:420px;resize:vertical;border:0;padding:10px;font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#364153;box-sizing:border-box;background:#fff}
#notes-app #text:focus{outline:0;box-shadow:none}.notes-composer:focus-within{border-color:#467b96}
#notes-app #wmd-preview{box-sizing:border-box;min-height:100px;max-height:420px;margin:0;padding:10px;overflow:auto;background:#fff}
.notes-composer-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px;border-top:1px solid #edf0f4}
#notes-app #wmd-button-bar{flex:1;min-width:0;margin:0}.notes-publish-options{display:flex;align-items:center;gap:4px;justify-content:flex-end;min-width:0}
.notes-icon{display:inline-grid;place-items:center;width:26px;height:26px;padding:0;border:0;background:transparent;color:#718096;font:14px/1 sans-serif;cursor:pointer;border-radius:2px}
.notes-icon:hover,.notes-icon:focus{background:#E9E9E6;color:#315f78;outline:0}.notes-icon:disabled{opacity:.45;cursor:not-allowed}
.notes-publish-options select{height:30px;max-width:130px;border:1px solid #dfe4ec;border-radius:3px;background:#fff;color:#536174;padding:0 24px 0 8px;font-size:12px}
.notes-publish-options select:focus{outline:0;box-shadow:none;border-color:#467b96}.notes-publish-options .btn{height:30px;padding:0 12px}.notes-publish-options [hidden]{display:none}
.notes-filterbar{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-top:12px;border-bottom:1px solid #e7eaf0}.notes-tabs{display:flex;gap:28px;overflow-x:auto}.notes-tabs button{flex:0 0 auto;border:0;border-bottom:2px solid transparent;background:transparent;color:#64748b;padding:11px 0 10px;cursor:pointer}
.notes-tabs button:hover{color:#315f78}.notes-tabs button.current{color:#315f78;border-bottom-color:#315f78}
.notes-search{display:flex;align-items:center;padding-bottom:7px}.notes-search input{width:180px;height:28px;background:#FFF;border:1px solid #D9D9D6;border-radius:2px;box-sizing:border-box;outline-offset:unset;}
#notes-notice:empty{display:none}#notes-notice{margin:12px 0 0;padding:8px 10px;border-left:3px solid #467b96;background:#eef6fa;color:#315f78}#notes-notice.error{border-color:#b94a48;background:#fff2f2;color:#9d302e}
.notes-list{min-height:150px}.notes-loading,.notes-empty{padding:42px 0;text-align:center;color:#9aa5b5}
.note-item{position:relative;padding:23px 0 22px;border-bottom:1px solid #edf0f4}
.note-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px;color:#a0aaba;font-size:12px}
.note-meta-left{display:flex;align-items:center;gap:8px;min-width:0}
.note-visibility{color:#7f8da1}.note-body{font-size:15px;line-height:1.8;color:#3f4b5f;overflow-wrap:anywhere}.note-body>:first-child{margin-top:0}.note-body>:last-child{margin-bottom:0}.note-body img{max-width:100%;height:auto;border-radius:3px}
.note-body .note-topic-highlight{padding:0 2px;color:#356f9f;background:#edf5ff;text-decoration:none;cursor:pointer}
.note-images{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:12px}.note-images a{display:block;aspect-ratio:1.35;overflow:hidden;border-radius:3px;background:#eef1f5}.note-images img{width:100%;height:100%;object-fit:cover}
.note-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;color:#a6afbc;font-size:12px}.note-counts{display:flex;gap:18px}.note-counts button,.note-actions button{border:0;padding:0;background:transparent;color:#8793a4;cursor:pointer}.note-counts button:hover,.note-actions button:hover{color:#315f78}.note-actions{display:flex;gap:12px}.note-actions .danger:hover{color:#b94a48}.note-body .note-reference{color:#356f9f;text-decoration:none;cursor:pointer}
.notes-more{display:block;margin:18px auto 0}.notes-sidebar{min-width:0;border-left:1px solid #edf0f4;padding-left:20px}
.notes-topic-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}.notes-topic-heading h3{margin:0;color:#66758a;font-size:13px;font-weight:600}.notes-topic-list{display:flex;flex-direction:column}
.notes-topic-list button{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;border:0;background:transparent;padding:8px;color:#536174;text-align:left;cursor:pointer}.notes-topic-list button:hover,.notes-topic-list button.current{color:#315f78;background:#f7f9fb}.notes-topic-list em{min-width:20px;padding:2px 5px;border-radius:3px;background:#eef1f5;color:#7c8797;font-style:normal;font-size:11px;text-align:center}
.notes-reference-dialog,.notes-comments-dialog{width:min(640px,calc(100vw - 32px));max-height:76vh;padding:0;border:0;border-radius:4px;color:#3f4b5f;box-shadow:0 20px 64px rgba(31,41,55,.28)}
.notes-reference-dialog::backdrop,.notes-comments-dialog::backdrop{background:rgba(15,23,42,.45)}.notes-reference-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #edf0f4}
.notes-reference-body,.notes-comments-body{padding:18px;overflow:auto;line-height:1.8}.notes-reference-body>:first-child{margin-top:0}.notes-reference-body>:last-child{margin-bottom:0}.notes-reference-body img{max-width:100%;height:auto}
.notes-reference-body .note-item{padding:0;border-bottom:none}
.notes-comment{padding:12px 0;border-bottom:1px solid #edf0f4}
.notes-comment:first-child{padding-top:0}.notes-comment:last-child{padding-bottom:0;border-bottom:none}
.notes-comment[data-depth="1"]{padding-left:20px}.notes-comment[data-depth="2"]{padding-left:40px}.notes-comment[data-depth="3"]{padding-left:60px}.notes-comment-meta{display:flex;align-items:center;gap:8px;color:#8a96a8;font-size:12px}.notes-comment-meta strong{color:#536174}.notes-comment-status{padding:0 4px;background:#f1f4f8}.notes-comment-content{margin:5px 0}.notes-comment-content>:first-child{margin-top:0}.notes-comment-content>:last-child{margin-bottom:0}.notes-comment-reply{border:0;padding:0;background:transparent;color:#467b96;cursor:pointer}.notes-comments-empty{padding:24px 0;color:#9aa5b5;text-align:center}#notes-comment-form{display:grid;gap:8px;margin-top:16px;padding-top:14px;border-top:1px solid #edf0f4}#notes-comment-text{box-sizing:border-box;width:100%;resize:vertical;border:1px solid #dfe4ec;border-radius:3px;padding:9px;font:inherit}#notes-comment-text:focus{outline:0;box-shadow:none;border-color:#467b96}.notes-comment-replying{color:#64748b;font-size:12px}.notes-comment-form-actions{display:flex;justify-content:flex-end;gap:8px}
@media(max-width:760px){#notes-app{grid-template-columns:minmax(0,1fr);gap:26px}.notes-sidebar{border-left:0;border-top:1px solid #edf0f4;padding:22px 0 0}.notes-composer-bar{align-items:stretch;flex-direction:column}.notes-publish-options{width:100%;flex-wrap:wrap;justify-content:flex-start}.notes-publish-options select:first-child{flex:1;max-width:none}.notes-filterbar{align-items:stretch;flex-direction:column;gap:0}.notes-tabs{gap:24px}.notes-search{padding:8px 0}.notes-search input{flex:1;width:auto}.note-images{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:420px){.notes-publish-options .btn{flex:1}.note-meta{align-items:flex-start}.note-footer{align-items:flex-start;flex-direction:column}.note-actions{align-self:flex-end}}
</style>

<script src="/vendor/hyperdown.js"></script>
<script src="/vendor/pagedown.js"></script>
<script src="/vendor/purify.js"></script>
<script>
(function(){
var csrf=${JSON.stringify(csrfToken)},state={page:1,status:"all",topic:0,keywords:"",totalPages:1,editing:0,notes:[],topics:[],commentCid:0,commentParent:0,comments:[]};
var content=document.getElementById("text"),statusSelect=document.getElementById("notes-status"),send=document.getElementById("notes-send"),cancel=document.getElementById("notes-cancel"),list=document.getElementById("notes-list"),notice=document.getElementById("notes-notice"),more=document.getElementById("notes-more"),searchForm=document.getElementById("notes-search-form"),searchInput=document.getElementById("notes-search-input"),referenceDialog=document.getElementById("notes-reference-dialog"),referenceBody=document.getElementById("notes-reference-body"),commentsDialog=document.getElementById("notes-comments-dialog"),commentsList=document.getElementById("notes-comments-list"),commentForm=document.getElementById("notes-comment-form"),commentText=document.getElementById("notes-comment-text"),commentReplying=document.getElementById("notes-comment-replying"),commentCancelReply=document.getElementById("notes-comment-cancel-reply"),markdownEditor=null,pendingImageCallback=null;
function E(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function tell(message,error){notice.textContent=message||"";notice.className=error?"error":""}
function relative(ts){var seconds=Math.max(0,Math.floor(Date.now()/1000)-Number(ts||0));if(seconds<60)return"刚刚";if(seconds<3600)return Math.floor(seconds/60)+" 分钟前";if(seconds<86400)return Math.floor(seconds/3600)+" 小时前";if(seconds<2592000)return Math.floor(seconds/86400)+" 天前";return new Date(Number(ts)*1000).toLocaleDateString("zh-CN")}
function statusName(v){return v==="private"?"私密":v==="draft"?"草稿":"公开"}
async function api(url,options){var response=await fetch(url,options),raw=await response.text(),data={};try{data=raw?JSON.parse(raw):{}}catch(e){}if(!response.ok)throw new Error(data.error||raw||("请求失败 ("+response.status+")"));return data}
function syncPreviewHeight(height){var preview=document.getElementById("wmd-preview"),next=height||content.offsetHeight;if(next)preview.style.height=next+"px"}
function refreshEditor(){if(markdownEditor)markdownEditor.refreshPreview();syncPreviewHeight()}
function insertText(before,after){var start=content.selectionStart,end=content.selectionEnd,value=content.value;content.value=value.slice(0,start)+before+value.slice(start,end)+after+value.slice(end);content.focus();content.selectionStart=start+before.length;content.selectionEnd=end+before.length;content.dispatchEvent(new Event("input",{bubbles:true}))}
function setEditorMode(mode){var previewMode=mode==="preview",editorHeight=content.offsetHeight;document.getElementById("wmd-editarea").classList.toggle("wmd-hidetab",previewMode);document.getElementById("wmd-preview").classList.toggle("wmd-hidetab",!previewMode);var row=document.getElementById("wmd-button-row");if(row)row.classList.toggle("wmd-visualhide",previewMode);document.querySelectorAll(".wmd-edittab a").forEach(function(link){link.classList.toggle("active",link.dataset.mode===mode)});if(previewMode){if(markdownEditor)markdownEditor.refreshPreview();syncPreviewHeight(editorHeight)}}
function setupMarkdownEditor(){
  if(typeof HyperDown!=="function"||!window.Markdown||typeof Markdown.Editor!=="function")return;
  var converter=new HyperDown(),options={strings:{bold:"加粗 <strong> Ctrl+B",boldexample:"加粗文字",italic:"斜体 <em> Ctrl+I",italicexample:"斜体文字",link:"链接 <a> Ctrl+L",linkdescription:"请输入链接描述",quote:"引用 <blockquote> Ctrl+Q",quoteexample:"引用文字",code:"代码 <pre><code> Ctrl+K",codeexample:"请输入代码",image:"上传图片 <img> Ctrl+G",imagedescription:"请输入图片描述",olist:"数字列表 <ol> Ctrl+O",ulist:"普通列表 <ul> Ctrl+U",litem:"列表项目",heading:"标题 <h1>/<h2> Ctrl+H",headingexample:"标题文字",ok:"确定",cancel:"取消",help:"Markdown 语法帮助"}};
  converter.enableHtml(true);converter.enableLine(true);
  converter.hook("makeHtml",function(html){return window.DOMPurify?DOMPurify.sanitize(html,{USE_PROFILES:{html:true}}):html});
  markdownEditor=new Markdown.Editor(converter,"",options);
  markdownEditor.hooks.set("insertImageDialog",function(callback){
    pendingImageCallback=callback;
    var imageInput=document.getElementById("notes-file");
    imageInput.click();
    window.addEventListener("focus",function(){setTimeout(function(){if(pendingImageCallback&&(!imageInput.files||!imageInput.files.length)){var cancelImage=pendingImageCallback;pendingImageCallback=null;cancelImage(null)}},300)},{once:true});
    return true;
  });
  markdownEditor.hooks.chain("commandExecuted",function(){content.dispatchEvent(new Event("input",{bubbles:true}))});
  content.addEventListener("keydown",function(event){if(!event.ctrlKey&&!event.metaKey)return;var key=String(event.key||"").toLocaleLowerCase();if(["r","z","y","j","e","m"].indexOf(key)<0)return;event.preventDefault();event.stopImmediatePropagation()},true);
  markdownEditor.run();
  document.querySelectorAll("#wmd-hr-button,#wmd-more-button,#wmd-undo-button,#wmd-redo-button,#wmd-fullscreen-button,#wmd-exit-fullscreen-button,#wmd-spacer2,#wmd-spacer3,#wmd-spacer4").forEach(function(button){button.remove()});
  document.getElementById("wmd-button-bar").insertAdjacentHTML("afterbegin",'<div class="wmd-edittab"><a href="#wmd-editarea" class="active" data-mode="write">撰写</a><a href="#wmd-preview" data-mode="preview">预览</a></div>');
  document.querySelectorAll(".wmd-edittab a").forEach(function(link){link.onclick=function(event){event.preventDefault();setEditorMode(link.dataset.mode||"write")}});
  if(window.ResizeObserver)new ResizeObserver(function(){syncPreviewHeight()}).observe(content);else window.addEventListener("resize",syncPreviewHeight);
}
function renderTopics(){
  document.getElementById("notes-topics").innerHTML=state.topics.map(function(t){return'<button type="button" data-topic="'+Number(t.mid)+'" class="'+(state.topic===Number(t.mid)?"current":"")+'" aria-pressed="'+(state.topic===Number(t.mid)?"true":"false")+'"><span>'+E(t.name||t.slug)+'</span><em>'+Number(t.count||0)+'</em></button>'}).join("");
  document.querySelectorAll("#notes-topics [data-topic]").forEach(function(button){button.onclick=function(){var topic=Number(button.dataset.topic||0);state.topic=state.topic===topic?0:topic;state.page=1;load(false)}})
}
function renderNote(note){var images=(note.images||[]).filter(function(image){return image&&image.url}).map(function(image){return'<a href="'+E(image.url)+'" target="_blank" rel="noopener noreferrer"><img src="'+E(image.url)+'" alt="'+E(image.name||"")+'" loading="lazy"></a>'}).join("");return'<article class="note-item" data-cid="'+Number(note.cid)+'"><div class="note-meta"><div class="note-meta-left"><time datetime="'+new Date(Number(note.created)*1000).toISOString()+'">'+E(relative(note.created))+'</time></div><span class="note-visibility">'+E(statusName(note.status))+'</span></div><div class="note-body">'+(note.html||"")+'</div>'+(images?'<div class="note-images">'+images+'</div>':"")+'<footer class="note-footer"><div class="note-counts"><button type="button" data-comments="'+Number(note.cid)+'">评论 '+Number(note.comments||0)+'</button></div><div class="note-actions"><button type="button" data-quote="'+Number(note.cid)+'">引用</button><button type="button" data-edit="'+Number(note.cid)+'">编辑</button><button type="button" class="danger" data-delete="'+Number(note.cid)+'">删除</button></div></footer></article>'}
function wireNotes(){
  list.querySelectorAll("[data-edit]").forEach(function(button){button.onclick=function(){var note=state.notes.find(function(item){return Number(item.cid)===Number(button.dataset.edit)});if(!note)return;state.editing=Number(note.cid);content.value=note.source||"";statusSelect.value=note.status||"publish";send.textContent="更新";cancel.hidden=false;setEditorMode("write");refreshEditor();content.focus();window.scrollTo({top:0,behavior:"smooth"})}});
  list.querySelectorAll("[data-quote]").forEach(function(button){button.onclick=function(){insertText("~/note/"+Number(button.dataset.quote)+" ","");content.focus();window.scrollTo({top:0,behavior:"smooth"})}});
  list.querySelectorAll("[data-comments]").forEach(function(button){button.onclick=function(){openComments(Number(button.dataset.comments||0))}});
  list.querySelectorAll("[data-note-ref]").forEach(function(link){link.onclick=function(event){event.preventDefault();openReference(Number(link.dataset.noteRef||0))}});
  list.querySelectorAll("[data-note-topic]").forEach(function(link){link.onclick=function(event){event.preventDefault();var name=String(link.dataset.noteTopic||"").toLocaleLowerCase(),topic=state.topics.find(function(item){return String(item.name||"").toLocaleLowerCase()===name||String(item.slug||"").toLocaleLowerCase()===name});if(!topic)return;var mid=Number(topic.mid||0);state.topic=state.topic===mid?0:mid;state.page=1;load(false)}});
  list.querySelectorAll("[data-delete]").forEach(function(button){button.onclick=async function(){if(!confirm("确认删除这条笔记及其评论吗？"))return;try{await mutate({action:"delete",cid:Number(button.dataset.delete)});tell("笔记已删除");state.page=1;await load(false)}catch(error){tell(error.message,true)}}});
}
function renderList(append){var html=state.notes.map(renderNote).join("");if(append)list.insertAdjacentHTML("beforeend",html);else list.innerHTML=html||'<div class="notes-empty">当前筛选下没有笔记</div>';wireNotes();more.hidden=state.page>=state.totalPages}
function resetCommentReply(){state.commentParent=0;commentReplying.hidden=true;commentReplying.textContent=""}
function renderComments(){
  var byParent=new Map(),known=new Set(state.comments.map(function(comment){return Number(comment.coid)}));
  state.comments.forEach(function(comment){var parent=known.has(Number(comment.parent))?Number(comment.parent):0,items=byParent.get(parent)||[];items.push(comment);byParent.set(parent,items)});
  var seen=new Set();
  function branch(parent,depth){return(byParent.get(parent)||[]).map(function(comment){var coid=Number(comment.coid);if(seen.has(coid))return"";seen.add(coid);var status=comment.status==="approved"?"":'<span class="notes-comment-status">'+E(comment.status)+"</span>";return'<article class="notes-comment" data-depth="'+Math.min(3,depth)+'"><div class="notes-comment-meta"><strong>'+E(comment.author||"匿名")+'</strong><time>'+E(relative(comment.created))+'</time>'+status+'</div><div class="notes-comment-content">'+String(comment.html||"")+'</div><button type="button" class="notes-comment-reply" data-comment-reply="'+coid+'" data-comment-author="'+E(comment.author||"匿名")+'">回复</button>'+branch(coid,depth+1)+"</article>"}).join("")}
  commentsList.innerHTML=state.comments.length?branch(0,0):'<div class="notes-comments-empty">还没有评论</div>';
  commentsList.querySelectorAll("[data-comment-reply]").forEach(function(button){button.onclick=function(){state.commentParent=Number(button.dataset.commentReply||0);commentReplying.textContent="回复 "+(button.dataset.commentAuthor||"匿名");commentReplying.hidden=false;commentCancelReply.hidden=false;commentText.focus()}})
}
async function openComments(cid){if(!Number.isSafeInteger(cid)||cid<1)return;state.commentCid=cid;resetCommentReply();commentText.value="";commentsList.innerHTML='<div class="notes-comments-empty">正在加载评论...</div>';if(!commentsDialog.open)commentsDialog.showModal();try{var result=await api("/api/admin/notes?commentsCid="+cid);state.comments=result.comments||[];renderComments()}catch(error){commentsList.innerHTML='<div class="notes-comments-empty">'+E(error.message||"评论加载失败")+'</div>'}}
async function load(append){try{if(!append)list.innerHTML='<div class="notes-loading">正在加载...</div>';var result=await api("/api/admin/notes?page="+state.page+"&pageSize=12&status="+encodeURIComponent(state.status)+"&topic="+state.topic+"&keywords="+encodeURIComponent(state.keywords));var data=result.data||[];state.notes=append?state.notes.concat(data):data;state.topics=result.topics||[];state.totalPages=(result.pagination||{}).totalPages||1;renderTopics();renderList(false)}catch(error){list.innerHTML='<div class="notes-empty">加载失败</div>';tell(error.message,true)}}
async function mutate(body){return api("/api/admin/notes",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify(body)})}
function resetComposer(){state.editing=0;content.value="";statusSelect.value="publish";send.textContent="发送";cancel.hidden=true;setEditorMode("write");refreshEditor()}
async function submit(){var value=content.value.trim();if(!value){tell("请先填写笔记内容",true);content.focus();return}send.disabled=true;try{await mutate({action:state.editing?"update":"create",cid:state.editing||undefined,content:value,status:statusSelect.value});tell(state.editing?"笔记已更新":"笔记已发布");resetComposer();state.page=1;await load(false)}catch(error){tell(error.message,true)}finally{send.disabled=false}}
async function openReference(cid){if(!Number.isSafeInteger(cid)||cid<1)return;referenceBody.textContent="正在加载笔记...";if(!referenceDialog.open)referenceDialog.showModal();try{var result=await api("/api/admin/notes?cid="+cid);var note=(result.data||[])[0];if(!note)throw new Error("笔记不存在");referenceBody.innerHTML='<article class="note-item"><div class="note-meta"><time>'+E(relative(note.created))+'</time></div><div class="note-body">'+(note.html||"")+'</div></article>';referenceBody.querySelectorAll("[data-note-ref]").forEach(function(link){link.onclick=function(event){event.preventDefault();openReference(Number(link.dataset.noteRef||0))}})}catch(error){referenceBody.textContent=error.message||"加载笔记失败"}}
document.querySelectorAll(".notes-tabs [data-status]").forEach(function(button){button.onclick=function(){document.querySelectorAll(".notes-tabs button").forEach(function(item){item.classList.remove("current")});button.classList.add("current");state.status=button.dataset.status||"all";state.page=1;load(false)}});
searchForm.onsubmit=function(event){event.preventDefault();event.stopImmediatePropagation();state.keywords=searchInput.value.trim().slice(0,100);state.page=1;load(false)};
searchInput.addEventListener("search",function(){if(searchInput.value||!state.keywords)return;state.page=1;state.keywords="";load(false)});
var file=document.getElementById("notes-file");file.onchange=async function(){if(!file.files||!file.files[0])return;var selected=file.files[0];file.disabled=true;try{var form=new FormData();form.append("file",selected);var result=await api("/api/admin/upload",{method:"POST",headers:{"X-CSRF-Token":csrf},body:form}),url=Array.isArray(result)?result[0]:"";if(!url)throw new Error("上传结果缺少图片地址");if(pendingImageCallback){var insertImage=pendingImageCallback;pendingImageCallback=null;insertImage(url)}else{insertText("!["+(selected.name||"image")+"]("+url+")","")}content.dispatchEvent(new Event("input",{bubbles:true}));tell("图片已上传")}catch(error){if(pendingImageCallback){var cancelImage=pendingImageCallback;pendingImageCallback=null;cancelImage(null)}tell(error.message,true)}finally{file.disabled=false;file.value=""}};
commentForm.onsubmit=async function(event){event.preventDefault();event.stopImmediatePropagation();var text=commentText.value.trim();if(!text)return;var submitButton=commentForm.querySelector('[type="submit"]');submitButton.disabled=true;try{await mutate({action:"reply-comment",cid:state.commentCid,parent:state.commentParent,text:text});commentText.value="";resetCommentReply();var note=state.notes.find(function(item){return Number(item.cid)===state.commentCid});if(note)note.comments=Number(note.comments||0)+1;renderList(false);await openComments(state.commentCid)}catch(error){tell(error.message,true)}finally{submitButton.disabled=false}};
commentCancelReply.onclick=function(){if(!commentReplying.textContent.trim()){commentsDialog.close();return}resetCommentReply()};document.getElementById("notes-comments-close").onclick=function(){commentsDialog.close()};commentsDialog.addEventListener("click",function(event){if(event.target===commentsDialog)commentsDialog.close()});
content.addEventListener("input",refreshEditor);send.onclick=submit;cancel.onclick=resetComposer;more.onclick=function(){state.page++;load(true)};document.getElementById("notes-reference-close").onclick=function(){referenceDialog.close()};referenceDialog.addEventListener("click",function(event){if(event.target===referenceDialog)referenceDialog.close()});setupMarkdownEditor();refreshEditor();load(false);
})();
</script>`;
}

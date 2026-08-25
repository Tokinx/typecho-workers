import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import init, { scribeDiffAlgo, SCRIBE_DIFF_ALGO_JS } from './index';

// Config-shape fixtures share one non-credential-like placeholder value; the
// validation logic under test does not inspect the key itself.
const TEST_API_KEY = 'x';

function collectHooks() {
  const hooks = new Map<string, Function[]>();
  init({
    pluginId: 'typecho-plugin-scribe',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      const list = hooks.get(point) || [];
      list.push(handler);
      hooks.set(point, list);
    },
  });
  return hooks;
}

describe('typecho-plugin-scribe', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('registers editor, config validation, and action hooks', () => {
    const hooks = collectHooks();

    expect([...hooks.keys()].sort()).toEqual([
      'admin:writePage:bottom',
      'admin:writePost:bottom',
      'plugin:config:beforeSave',
      'plugin:typecho-plugin-scribe:action',
      'plugin:typecho-plugin-scribe:action:auth',
    ]);
  });

  it('injects the AI writer editor control into post and page editors', () => {
    const hooks = collectHooks();
    const postHtml = hooks.get('admin:writePost:bottom')![0]('');
    const pageHtml = hooks.get('admin:writePage:bottom')![0]('');

    expect(postHtml).toContain('typecho-scribe');
    expect(postHtml).toContain('data-content-type="post"');
    expect(postHtml).toContain("MODE_LABELS = { generate: '生成', polish: '润色', correct: '纠错' }");
    expect(postHtml).toContain("button.innerHTML = (MODE_ICONS[mode] || '') + '<span>' + title + '</span>'");
    expect(postHtml).toContain('typecho-scribe-menu-actions');
    expect(postHtml).toContain('data-scribe-setting="userPrompt"');
    expect(postHtml).toContain('data-scribe-setting="outputLanguage"');
    expect(postHtml).toContain('data-scribe-setting="stylePostCount"');
    expect(postHtml).toContain('data-scribe-setting="targetAudience"');
    expect(postHtml).toContain('data-scribe-setting="lengthPreset"');
    expect(postHtml).toContain('data-scribe-setting="factPolicy"');
    expect(postHtml).toContain('data-scribe-setting="includeBodyAssets"');
    // 高级设置两列 grid 布局，checkbox 项跨两列
    expect(postHtml).toContain('grid-template-columns: 1fr 1fr');
    expect(postHtml).toContain('.typecho-scribe-advanced-fields .typecho-scribe-setting-wide');
    expect(postHtml).toContain('typecho-scribe-setting typecho-scribe-setting-wide');
    expect(postHtml).toContain("menu.addEventListener('click', function(event) {");
    expect(postHtml).toContain(
      "      if (event.target && event.target.closest && event.target.closest('.typecho-scribe-menu')) return;",
    );
    expect(postHtml).toContain('参考历史文章');
    expect(postHtml).toContain('<option value="0">不参考</option>');
    expect(postHtml).toContain('<option value="5">5</option>');
    expect(postHtml).toContain('<option value="10">10</option>');
    expect(postHtml).not.toContain('<option value="1">1</option>');
    expect(pageHtml).toContain('data-content-type="page"');
  });

  it('injects a preview modal with streaming output, follow-up input, and confirm/cancel actions', () => {
    const hooks = collectHooks();
    const postHtml = hooks.get('admin:writePost:bottom')![0]('');

    expect(postHtml).toContain('typecho-scribe-modal');
    expect(postHtml).toContain('typecho-scribe-modal-preview');
    expect(postHtml).toContain('typecho-scribe-modal-followup-input');
    expect(postHtml).toContain('输入调整要求，发送后 AI 将结合原文与当前结果继续调整');
    expect(postHtml).toContain('Enter 发送 · Shift+Enter 换行');
    expect(postHtml).toContain("event.key === 'Enter' && !event.shiftKey");
    expect(postHtml).toContain('>取消</button>');
    expect(postHtml).toContain('>确定</button>');
    expect(postHtml).toContain('typecho-scribe-modal-status');
    expect(postHtml).toContain('closePreviewModal(true)');
    expect(postHtml).toContain('action: previewState.followUpPrompt ? \'continue\' : previewState.mode');
    expect(postHtml).toContain('payload.originalBody = previewState.oldText;');
    expect(postHtml).toContain('payload.followUpPrompt = previewState.followUpPrompt;');
  });

  it('injects write/preview/compare tabs and an editable write textarea into the modal', () => {
    const hooks = collectHooks();
    const postHtml = hooks.get('admin:writePost:bottom')![0]('');

    expect(postHtml).toContain('data-scribe-tab="write"');
    expect(postHtml).toContain('data-scribe-tab="preview"');
    expect(postHtml).toContain('data-scribe-tab="compare"');
    expect(postHtml).toContain('typecho-scribe-modal-write');
    expect(postHtml).toContain('typecho-scribe-modal-compare-original');
    expect(postHtml).toContain('typecho-scribe-modal-compare-generated');
    expect(postHtml).toContain('typecho-scribe-modal-compare-label');
    // 预览容器复用 #wmd-preview 排版（wmd-preview class）；比对容器为纯 markdown 源码视图
    expect(postHtml).toContain('typecho-scribe-modal-preview wmd-preview');
    expect(postHtml).toContain('typecho-scribe-modal-compare-content typecho-scribe-modal-compare-original');
    expect(postHtml).toContain('typecho-scribe-modal-compare-content typecho-scribe-modal-compare-generated');
    expect(postHtml).toContain('setModalTab(button.getAttribute(\'data-scribe-tab\') || \'write\')');
    expect(postHtml).toContain('previewState.userEdited = true;');
    expect(postHtml).toContain('renderModalViews();');
    expect(postHtml).toContain('window.HyperDown && window.DOMPurify');
    expect(postHtml).toContain('converter.enableHtml(true);');
    expect(postHtml).toContain('window.DOMPurify.sanitize(converter.makeHtml(source)');
    // 模板字符串内的正则必须用双反斜杠，避免 \n 被解释为真实换行导致语法错误
    expect(postHtml).toContain("escapeHtmlText(source).replace(/\\n/g, '<br>')");
  });

  it('emits browser-executable inline scripts (no template-literal escape regressions)', () => {
    const hooks = collectHooks();
    const postHtml = hooks.get('admin:writePost:bottom')![0]('');

    // 将内联脚本交给运行时解析，捕获 \n 被模板字符串解释为换行之类的语法错误。
    const scripts = [...postHtml.matchAll(/<script is:inline>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const source of scripts) {
      expect(() => transformSync(source, { loader: 'js' })).not.toThrow();
    }
  });

  it('keeps the connection-only plugin config and reads editor settings from the mounted menu', () => {
    const hooks = collectHooks();
    const postHtml = hooks.get('admin:writePost:bottom')![0]('');
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

    expect(Object.keys(pkg.typecho.plugin.config).sort()).toEqual([
      'apiKey',
      'endpoint',
      'maxTokens',
      'model',
      'temperature',
    ]);
    expect(postHtml).toContain("writingOptions: collectWritingSettings(previewState.box.querySelector('.typecho-scribe-menu') || previewState.box)");
    expect(postHtml).toContain('saveWritingSettings(collectWritingSettings(settings))');
  });

  it('ignores config validation for other plugins', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')![0];
    const original = { success: true, settings: { endpoint: '' } };

    await expect(validate(original, {
      pluginId: 'other-plugin',
      settings: {},
    })).resolves.toBe(original);
  });

  it('rejects incomplete LLM config before saving', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')![0];

    const result = await validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-scribe',
      settings: {
        endpoint: '',
        apiKey: '',
        model: '',
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: '请填写接口地址、API Key 和模型名称',
    });
  });

  it('rejects unsupported writing profile config before saving', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')![0];

    const result = await validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-scribe',
      settings: {
        endpoint: 'https://llm.example/v1',
        apiKey: TEST_API_KEY,
        model: 'demo-model',
        outputLanguage: 'fr',
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: '输出语言配置不正确',
    });
  });

  it('accepts max tokens up to 512K and rejects values beyond the cap', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')![0];

    const ok = await validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-scribe',
      settings: {
        endpoint: 'https://llm.example/v1',
        apiKey: TEST_API_KEY,
        model: 'demo-model',
        maxTokens: '512000',
      },
    });
    expect(ok).toMatchObject({ success: true, settings: { maxTokens: '512000' } });

    const rejected = await validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-scribe',
      settings: {
        endpoint: 'https://llm.example/v1',
        apiKey: TEST_API_KEY,
        model: 'demo-model',
        maxTokens: '512001',
      },
    });
    expect(rejected).toMatchObject({
      success: false,
      error: 'max tokens 必须是 128 到 512000 之间的整数',
    });
  });

  it('saves connection settings without blocking on live model validation', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')![0];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-scribe',
      settings: {
        endpoint: 'https://llm.example/v1',
        apiKey: TEST_API_KEY,
        model: 'demo-model',
      },
    });

    expect(result).toMatchObject({
      success: true,
      settings: {
        endpoint: 'https://llm.example/v1',
        apiKey: TEST_API_KEY,
        model: 'demo-model',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns not handled for unsupported plugin actions', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-scribe:action')![0];
    const original = { handled: false };

    await expect(action(original, { action: 'unknown', payload: {} })).resolves.toBe(original);
  });

  it('grants contributor access to generate, polish, correct, and continue actions', () => {
    const hooks = collectHooks();
    const auth = hooks.get('plugin:typecho-plugin-scribe:action:auth')![0];

    expect(auth('administrator', { action: 'generate' })).toBe('contributor');
    expect(auth('administrator', { action: 'polish' })).toBe('contributor');
    expect(auth('administrator', { action: 'correct' })).toBe('contributor');
    expect(auth('administrator', { action: 'continue' })).toBe('contributor');
    expect(auth('administrator', { action: 'unknown' })).toBe('administrator');
  });

  it('rejects continue actions without a follow-up prompt', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-scribe:action')![0];

    const result = await action({ handled: false }, {
      action: 'continue',
      payload: {
        contentType: 'post',
        title: 'LLM 写作实践',
        body: '当前结果',
        originalBody: '原文',
      },
      options: {
        'plugin:typecho-plugin-scribe': JSON.stringify({
          endpoint: 'https://llm.example/v1',
          apiKey: TEST_API_KEY,
          model: 'demo-model',
        }),
      },
    });

    expect(result).toMatchObject({
      handled: true,
      success: false,
      error: '缺少调整要求',
    });
  });

  it('submits the original text, current result, and follow-up prompt together for continue actions', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-scribe:action')![0];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      'data: {"choices":[{"delta":{"content":"调整后正文"}}]}\n\ndata: [DONE]\n\n',
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await action({ handled: false }, {
      action: 'continue',
      payload: {
        contentType: 'post',
        title: 'LLM 写作实践',
        body: 'AI 生成的当前结果',
        originalBody: '编辑器的原始正文',
        followUpPrompt: '请压缩到三段以内',
      },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-scribe': JSON.stringify({
          endpoint: 'https://llm.example/v1',
          apiKey: TEST_API_KEY,
          model: 'demo-model',
        }),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.success).toBe(true);
    expect(result.response).toBeInstanceOf(Response);
    expect(fetchMock).toHaveBeenCalledWith('https://llm.example/v1/chat/completions', expect.any(Object));

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.stream).toBe(true);
    const userContent = String(body.messages[1].content);
    expect(userContent).toContain('<original_draft>');
    expect(userContent).toContain('编辑器的原始正文');
    expect(userContent).toContain('<current_result>');
    expect(userContent).toContain('AI 生成的当前结果');
    expect(userContent).toContain('<user_adjustment>');
    expect(userContent).toContain('请压缩到三段以内');
    expect(userContent).toContain('调整后的完整');
  });

  it('handles generation action with a clear configuration error', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-scribe:action')![0];

    const result = await action({ handled: false }, {
      action: 'generate',
      payload: { contentType: 'post', title: 'Test' },
      options: {
        'plugin:typecho-plugin-scribe': JSON.stringify({
          endpoint: 'https://llm.example/v1',
          apiKey: '',
          model: 'demo-model',
        }),
      },
    });

    expect(result).toMatchObject({
      handled: true,
      success: false,
      error: '请先完整配置接口地址、API Key 和模型名称',
    });
  });

  it('reports the LLM timeout before the generic plugin action timeout', async () => {
    vi.useFakeTimers();
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-scribe:action')![0];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = action({ handled: false }, {
      action: 'generate',
      payload: { contentType: 'post', title: 'Test' },
      options: {
        'plugin:typecho-plugin-scribe': JSON.stringify({
          endpoint: 'https://llm.example/v1',
          apiKey: TEST_API_KEY,
          model: 'demo-model',
        }),
      },
    });

    await vi.advanceTimersByTimeAsync(55_000);
    const result = await pending;

    expect(result).toMatchObject({
      handled: true,
      success: false,
      error: 'LLM 请求超时，请稍后重试',
    });
  });

  it('sends structured writing context and output contract to the LLM', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-scribe:action')![0];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      'data: {"choices":[{"delta":{"content":"正文"}}]}\n\ndata: [DONE]\n\n',
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await action({ handled: false }, {
      action: 'generate',
      payload: {
        contentType: 'post',
        title: 'LLM 写作实践',
      },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-scribe': JSON.stringify({
          endpoint: 'https://llm.example/v1',
          apiKey: TEST_API_KEY,
          model: 'demo-model',
          outputLanguage: 'en',
          targetAudience: '后端工程师',
          lengthPreset: 'detailed',
          factPolicy: 'conservative',
          userPrompt: '避免营销腔。',
        }),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.success).toBe(true);
    expect(result.response).toBeInstanceOf(Response);
    expect(fetchMock).toHaveBeenCalledWith('https://llm.example/v1/chat/completions', expect.any(Object));

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.stream).toBe(true);
    expect(body.messages[0].content).toContain('资深内容编辑助手');
    expect(body.messages[1].content).toContain('<style_samples>');
    expect(body.messages[1].content).toContain('<writing_profile>');
    expect(body.messages[1].content).toContain('输出语言：固定使用：en');
    expect(body.messages[1].content).toContain('目标读者：后端工程师');
    expect(body.messages[1].content).toContain('篇幅策略：深入');
    expect(body.messages[1].content).toContain('<task>');
    expect(body.messages[1].content).toContain('<output_contract>');
  });

  it('applies editor writing options from the action payload', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-scribe:action')![0];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      'data: {"choices":[{"delta":{"content":"正文"}}]}\n\ndata: [DONE]\n\n',
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await action({ handled: false }, {
      action: 'generate',
      payload: {
        contentType: 'post',
        title: 'LLM 写作实践',
        writingOptions: {
          outputLanguage: 'zh-CN',
          targetAudience: '前端开发者',
          lengthPreset: 'concise',
          factPolicy: 'assumptive',
          userPrompt: '避免营销腔。',
          includeBodyAssets: true,
          stylePostCount: '1',
        },
      },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-scribe': JSON.stringify({
          endpoint: 'https://llm.example/v1',
          apiKey: TEST_API_KEY,
          model: 'demo-model',
        }),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://llm.example/v1/chat/completions', expect.any(Object));

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.messages[1].content).toContain('输出语言：固定使用：zh-CN');
    expect(body.messages[1].content).toContain('目标读者：前端开发者');
    expect(body.messages[1].content).toContain('篇幅策略：偏短');
    expect(body.messages[1].content).toContain('事实策略：允许基于常识做低风险推断');
    expect(body.messages[1].content).toContain('避免营销腔。');
    expect(body.messages[1].content).toContain('<assets>');
  });

  it('injects the wider modal and diff highlight markup into the editor HTML', () => {
    const hooks = collectHooks();
    const postHtml = hooks.get('admin:writePost:bottom')![0]('');
    const pageHtml = hooks.get('admin:writePage:bottom')![0]('');

    expect(postHtml).toContain('width: min(1280px, 100%)');
    expect(pageHtml).toContain('width: min(1280px, 100%)');
    // 高亮样式与无差异提示
    expect(postHtml).toContain('typecho-scribe-diff-del');
    expect(postHtml).toContain('typecho-scribe-diff-ins');
    expect(postHtml).toContain('typecho-scribe-diff-note');
    // 比对视图走 diff 渲染管线，仅在比对页签激活时计算；纯 markdown 源码对比（pre + 转义 + span）
    expect(postHtml).toContain("if (previewState.tab === 'compare') {");
    expect(postHtml).toContain('renderComparePanes(originalEl, generatedEl, previewState.oldText, text)');
    expect(postHtml).toContain("var diff = scribeDiffMarkup(oldText || '', newText || '')");
    expect(postHtml).toContain('scribeRestoreMarks(escapeHtmlText(block.old))');
    expect(postHtml).toContain('typecho-scribe-modal-compare-md');
    // 比对视图不再依赖 HyperDown/DOMPurify 渲染与 wmd-preview 排版
    expect(postHtml).toContain('<pre class="typecho-scribe-modal-compare-md">' + "' + oldHtml + '</pre>'");
    expect(postHtml).not.toContain('wmd-preview typecho-scribe-modal-compare');
    // 算法源码经 toString() 序列化注入内联脚本（可执行，语法检查由上方用例覆盖）；
    // 还原 span 的 class 与 CSS 定义一致（转译器会重写字符串引号风格，故按值断言）
    expect(postHtml).toContain('function scribeDiffMarkup(');
    expect(SCRIBE_DIFF_ALGO_JS).toContain('typecho-scribe-diff-del');
    expect(SCRIBE_DIFF_ALGO_JS).toContain('typecho-scribe-diff-ins');
    expect(SCRIBE_DIFF_ALGO_JS).toContain('scribeRestoreMarks');
  });

  it('binds dual-pane scroll sync for the compare view', () => {
    const hooks = collectHooks();
    const postHtml = hooks.get('admin:writePost:bottom')![0]('');

    // 双向互绑：左右两栏的 scroll 事件都走 onCompareScroll
    expect(postHtml).toContain("compareOriginal.addEventListener('scroll', function() {");
    expect(postHtml).toContain("compareGenerated.addEventListener('scroll', function() {");
    expect(postHtml).toContain('onCompareScroll(compareOriginal, compareGenerated)');
    expect(postHtml).toContain('onCompareScroll(compareGenerated, compareOriginal)');
    // 比例同步逻辑：以最近滚动源为准，±2px 阈值防回环抖动
    expect(postHtml).toContain('var compareScrollSource = null;');
    expect(postHtml).toContain('var compareScrollSyncing = false;');
    expect(postHtml).toContain('syncCompareScroll(source, target)');
    expect(postHtml).toContain('Math.abs(target.scrollTop - next) >= 2');
    expect(postHtml).toContain('compareScrollSource = source;');
    // 内容重渲染后按最近滚动源恢复同步；关闭弹窗时重置滚动源
    expect(postHtml).toContain('if (compareScrollSource === generatedEl) {');
    expect(postHtml).toContain('syncCompareScroll(generatedEl, originalEl);');
    expect(postHtml).toContain('syncCompareScroll(originalEl, generatedEl);');
    expect(postHtml).toContain('compareScrollSource = null;');
  });

  describe('diff highlight algorithm', () => {
    const { scribeDiffMarkup, scribeRestoreMarks, scribeTokenize } = scribeDiffAlgo;

    it('reports no difference for identical texts', () => {
      const result = scribeDiffMarkup('同一段文字\n第二行', '同一段文字\n第二行');
      expect(result.hasDiff).toBe(false);
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].words).toBeNull();
      expect(result.blocks[0].old).toBe('同一段文字\n第二行');
    });

    it('marks word-level deletion and insertion around a local replacement', () => {
      const result = scribeDiffMarkup('a b c', 'a X c');
      expect(result.hasDiff).toBe(true);
      const diffBlock = result.blocks.find((b) => b.words !== null)!;
      expect(diffBlock.old).toBe('a \u0001b\u0002 c');
      expect(diffBlock.new).toBe('a \u0003X\u0004 c');
      expect(diffBlock.old).not.toContain('\u0003');
      expect(diffBlock.new).not.toContain('\u0001');
    });

    it('keeps unchanged markdown syntax markers unmarked', () => {
      const result = scribeDiffMarkup('**bold** text', '**bold** changed');
      const diffBlock = result.blocks.find((b) => b.words !== null)!;
      expect(diffBlock.old).toBe('**bold** \u0001text\u0002');
      expect(diffBlock.old).not.toContain('\u0001bold\u0002');
      expect(diffBlock.new).toBe('**bold** \u0003changed\u0004');
    });

    it('handles whole-block insertion and deletion', () => {
      const inserted = scribeDiffMarkup('', '新段落');
      expect(inserted.hasDiff).toBe(true);
      expect(inserted.blocks[0].old).toBe('');
      expect(inserted.blocks[0].new).toBe('\u0003新段落\u0004');

      const deleted = scribeDiffMarkup('旧段落', '');
      expect(deleted.hasDiff).toBe(true);
      expect(deleted.blocks[0].old).toBe('\u0001旧段落\u0002');
      expect(deleted.blocks[0].new).toBe('');
    });

    it('keeps line-level equal runs in separate blocks', () => {
      const result = scribeDiffMarkup('a\nb', 'a\nb\nc');
      expect(result.blocks).toHaveLength(2);
      expect(result.blocks[0].words).toBeNull();
      expect(result.blocks[0].old).toBe('a\nb');
      expect(result.blocks[1].words).not.toBeNull();
      expect(result.blocks[1].new).toBe('\u0003c\u0004');
    });

    it('merges nearby diff blocks with short equal context into one block', () => {
      const result = scribeDiffMarkup('p1\nctx\np2', 'p1x\nctx\np2y');
      const diffBlocks = result.blocks.filter((b) => b.words !== null);
      expect(diffBlocks).toHaveLength(1);
      expect(diffBlocks[0].old).toBe('\u0001p1\u0002\nctx\n\u0001p2\u0002');
      expect(diffBlocks[0].new).toBe('\u0003p1x\u0004\nctx\n\u0003p2y\u0004');
      expect(diffBlocks[0].old).not.toContain('\u0001ctx\u0002');
    });

    it('does not wrap newline tokens inside word-level diffs', () => {
      const result = scribeDiffMarkup('x\ny', 'x y');
      const diffBlock = result.blocks.find((b) => b.words !== null)!;
      expect(diffBlock.old).toBe('x\ny');
      expect(diffBlock.new).toBe('x\u0003 \u0004y');
    });

    it('degrades to whole-block marking for very large difference regions', () => {
      const big = 'x'.repeat(20000);
      const result = scribeDiffMarkup(big, 'y'.repeat(20000));
      expect(result.hasDiff).toBe(true);
      const diffBlock = result.blocks.find((b) => b.words !== null)!;
      expect(diffBlock.words).toBe('whole');
      expect(diffBlock.old).toBe('\u0001' + big + '\u0002');
      expect(diffBlock.new).toBe('\u0003' + 'y'.repeat(20000) + '\u0004');
    });

    it('tokenizes CJK words, latin words, and punctuation separately', () => {
      expect(scribeTokenize('你好世界 abc_123.')).toEqual(['你好世界', ' ', 'abc_123', '.']);
      expect(scribeTokenize('a\nb')).toEqual(['a', '\n', 'b']);
    });

    it('restores del/ins placeholders to highlight spans', () => {
      expect(scribeRestoreMarks('x\u0001y\u0002z')).toBe('x<span class="typecho-scribe-diff-del">y</span>z');
      expect(scribeRestoreMarks('x\u0003y\u0004z')).toBe('x<span class="typecho-scribe-diff-ins">y</span>z');
      expect(scribeRestoreMarks('plain')).toBe('plain');
    });

    it('keeps unchanged images renderable (identical markdown stays in equal blocks)', () => {
      const result = scribeDiffMarkup('![图](https://x/y.png)', '![图](https://x/y.png)');
      expect(result.hasDiff).toBe(false);
      expect(result.blocks[0].words).toBeNull();
      expect(result.blocks[0].old).toBe('![图](https://x/y.png)');
    });

    it('marks a removed image as one del-highlighted markdown run', () => {
      const result = scribeDiffMarkup('![图](https://x/y.png)\n正文', '正文');
      const diffBlock = result.blocks.find((b) => b.words !== null)!;
      expect(diffBlock.old).toBe('\u0001![图](https://x/y.png)\u0002');
      expect(scribeRestoreMarks(diffBlock.old)).toBe(
        '<span class="typecho-scribe-diff-del">![图](https://x/y.png)</span>',
      );
    });

    it('marks an added image as one ins-highlighted markdown run', () => {
      const result = scribeDiffMarkup('正文', '正文\n\n![新图](https://x/z.png)');
      const diffBlock = result.blocks.find((b) => b.words !== null)!;
      expect(diffBlock.new).toBe('\n\u0003![新图](https://x/z.png)\u0004');
      expect(scribeRestoreMarks(diffBlock.new)).toBe(
        '\n<span class="typecho-scribe-diff-ins">![新图](https://x/z.png)</span>',
      );
    });

    it('keeps identical markdown syntax tokens unmarked (image stays untouched)', () => {
      const result = scribeDiffMarkup('![图](https://x/y.png) 说明', '![图](https://x/y.png) 新说明');
      const diffBlock = result.blocks.find((b) => b.words !== null)!;
      // 语法 token（! [ ] ( ) https://…）相等 → 不高亮；CJK 词级分词把「新说明」视为一个词
      expect(diffBlock.old).toBe('![图](https://x/y.png) \u0001说明\u0002');
      expect(diffBlock.new).toBe('![图](https://x/y.png) \u0003新说明\u0004');
    });

    it('highlights changed link URLs at word level without breaking the syntax', () => {
      const result = scribeDiffMarkup('[链接](https://x/a)', '[链接](https://x/b)');
      const diffBlock = result.blocks.find((b) => b.words !== null)!;
      expect(diffBlock.old).toBe('[链接](https://x/\u0001a\u0002)');
      expect(diffBlock.new).toBe('[链接](https://x/\u0003b\u0004)');
    });

    it('highlights changed link labels while keeping the url tokens equal', () => {
      const result = scribeDiffMarkup('[旧名](https://x/u)', '[新名](https://x/u)');
      const diffBlock = result.blocks.find((b) => b.words !== null)!;
      expect(diffBlock.old).toBe('[\u0001旧名\u0002](https://x/u)');
      expect(diffBlock.new).toBe('[\u0003新名\u0004](https://x/u)');
    });

    it('highlights the changed definition URL of a reference-style image', () => {
      const result = scribeDiffMarkup('![图][1]\n\n[1]: https://x/y.png', '![图][1]\n\n[1]: https://x/z.png');
      // 引用行与定义语法 token 相等 → 原样；仅定义 URL 中变化的词级 token 高亮（y → z，扩展名不变）
      const diffBlock = result.blocks.find((b) => b.words !== null)!;
      expect(diffBlock.old).toBe('[1]: https://x/\u0001y\u0002.png');
      expect(diffBlock.new).toBe('[1]: https://x/\u0003z\u0004.png');
    });

    it('marks a replaced horizontal rule as a single highlighted run', () => {
      const result = scribeDiffMarkup('标题\n---\n正文', '标题\n***\n正文');
      const diffBlock = result.blocks.find((b) => b.words !== null)!;
      expect(diffBlock.old).toBe('\u0001---\u0002');
      expect(diffBlock.new).toBe('\u0003***\u0004');
    });

    it('keeps table pipe tokens unmarked when only cell content changes', () => {
      const result = scribeDiffMarkup('| a | b |', '| a | c |');
      const diffBlock = result.blocks.find((b) => b.words !== null)!;
      expect(diffBlock.old).toBe('| a | \u0001b\u0002 |');
      expect(diffBlock.new).toBe('| a | \u0003c\u0004 |');
    });
  });
});

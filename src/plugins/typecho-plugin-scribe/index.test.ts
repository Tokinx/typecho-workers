import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import init from './index';

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
    // 预览与比对容器复用 #wmd-preview 排版（wmd-preview class）
    expect(postHtml).toContain('typecho-scribe-modal-preview wmd-preview');
    expect(postHtml).toContain('typecho-scribe-modal-compare-content wmd-preview');
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
});

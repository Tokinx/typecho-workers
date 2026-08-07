import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import init from './index';

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
    expect(postHtml).toContain("menu.addEventListener('click', function(event) {");
    expect(postHtml).toContain('参考历史文章');
    expect(postHtml).toContain('<option value="0">不参考</option>');
    expect(postHtml).toContain('<option value="5">5</option>');
    expect(postHtml).toContain('<option value="10">10</option>');
    expect(postHtml).not.toContain('<option value="1">1</option>');
    expect(pageHtml).toContain('data-content-type="page"');
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
    expect(postHtml).toContain("var menu = button ? button.closest('.typecho-scribe-menu') : null;");
    expect(postHtml).toContain('writingOptions: collectWritingSettings(menu || box)');
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
        apiKey: 'test-key',
        model: 'demo-model',
        outputLanguage: 'fr',
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: '输出语言配置不正确',
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
        apiKey: 'test-key',
        model: 'demo-model',
      },
    });

    expect(result).toMatchObject({
      success: true,
      settings: {
        endpoint: 'https://llm.example/v1',
        apiKey: 'test-key',
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
          apiKey: 'test-key',
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
          apiKey: 'test-key',
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
          apiKey: 'test-key',
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

import { fetchWithTimeout, parseAttachmentMeta, parsePluginOption, stripTypechoMarkers } from 'typecho/plugin-sdk';
import type { AttachmentMeta, PluginInitContext } from 'typecho/plugin-sdk';
import type { Database } from 'typecho/db';
import { schema } from 'typecho/db';
import { and, desc, eq, inArray, or } from 'drizzle-orm';

type WriterMode = 'generate' | 'polish' | 'correct' | 'continue';
type ContentType = 'post' | 'page';
type LengthPreset = 'concise' | 'balanced' | 'detailed';
type FactPolicy = 'conservative' | 'assumptive';

const LENGTH_PRESETS = ['concise', 'balanced', 'detailed'] as const;
const FACT_POLICIES = ['conservative', 'assumptive'] as const;
const OUTPUT_LANGUAGES = ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const;

const LENGTH_LABELS: Record<LengthPreset, string> = {
  concise: '偏短：聚焦核心观点，避免铺陈。',
  balanced: '标准：结构完整，信息密度适中。',
  detailed: '深入：展开背景、细节、例证和必要的小结。',
};

interface ScribeConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: string;
  maxTokens: string;
  stylePostCount: string;
  outputLanguage: string;
  targetAudience: string;
  lengthPreset: LengthPreset;
  factPolicy: FactPolicy;
  userPrompt: string;
  includeBodyAssets: string;
}

interface WriterPayload {
  contentType?: ContentType;
  title?: string;
  body?: string;
  cid?: number | string;
  attachmentIds?: Array<number | string>;
  writingOptions?: WriterWritingOptions;
  // continue 模式专用：编辑器原文与用户追加的调整要求
  originalBody?: string;
  followUpPrompt?: string;
}

interface WriterWritingOptions {
  stylePostCount?: string | number;
  outputLanguage?: string;
  targetAudience?: string;
  lengthPreset?: LengthPreset;
  factPolicy?: FactPolicy;
  userPrompt?: string;
  includeBodyAssets?: string | boolean;
}

interface PluginActionResult {
  handled?: boolean;
  success?: boolean;
  content?: string;
  error?: string;
  response?: Response;
}

interface ConfigValidationResult {
  success: boolean;
  settings?: ScribeConfig;
  error?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface ChatCompletionStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    message?: {
      content?: string;
    };
  }>;
}

interface StyleSample {
  title: string;
  text: string;
}

interface ContentAsset {
  source: 'body' | 'attachment';
  kind: 'image' | 'file';
  title: string;
  url: string;
  mime?: string;
  size?: number;
  cid?: number;
}

type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

const PLUGIN_ID = 'typecho-plugin-scribe';

const DEFAULTS: ScribeConfig = {
  endpoint: 'https://open.bigmodel.cn/api/paas/v4/',
  apiKey: '',
  model: 'glm-4.7-flash',
  temperature: '0.7',
  maxTokens: '32000',
  stylePostCount: '5',
  outputLanguage: 'auto',
  targetAudience: '',
  lengthPreset: 'balanced',
  factPolicy: 'conservative',
  userPrompt: '',
  includeBodyAssets: '0',
};

// Keep the LLM request timeout below the generic plugin-action timeout so a
// slow provider surfaces Scribe's specific error instead of a generic 500.
const LLM_REQUEST_TIMEOUT_MS = 55_000;
// 单次最大输出 Token 上限（512K = 512000）
const MAX_OUTPUT_TOKENS = 512_000;
const SYSTEM_PROMPT = [
  '你是一位资深内容编辑助手。',
  '你的目标是帮助作者生成、润色或纠错可直接保存的正文，而不是回答关于写作过程的问题。',
  '先在内部完成任务理解、风格归纳、结构规划和事实风险检查，但不要输出分析过程、计划、检查清单或解释。',
  '严格遵守用户提供的标题、已有正文、站点风格样本、附件资料和管理员写作要求。',
  '不要编造事实、出处、数字、人物、机构或链接；上下文不足时使用克制、可核验的表述。',
  '默认输出 Markdown 正文。除非用户明确要求，不要输出 front matter、JSON、代码围栏、标题重复、问候语或说明文字。',
  '润色和纠错任务必须返回完整正文，不能只返回修改或新增片段。',
].join('\n');

function normalizeConfig(settings?: Record<string, unknown>): ScribeConfig {
  return {
    endpoint: String(settings?.endpoint || '').trim(),
    apiKey: String(settings?.apiKey || '').trim(),
    model: String(settings?.model || '').trim(),
    temperature: String(settings?.temperature || DEFAULTS.temperature).trim(),
    maxTokens: String(settings?.maxTokens || DEFAULTS.maxTokens).trim(),
    stylePostCount: String(settings?.stylePostCount || DEFAULTS.stylePostCount).trim(),
    outputLanguage: String(settings?.outputLanguage || DEFAULTS.outputLanguage).trim(),
    targetAudience: String(settings?.targetAudience || DEFAULTS.targetAudience).trim(),
    lengthPreset: normalizeLengthPreset(settings?.lengthPreset),
    factPolicy: normalizeFactPolicy(settings?.factPolicy),
    userPrompt: String(settings?.userPrompt || DEFAULTS.userPrompt).trim(),
    includeBodyAssets: String(settings?.includeBodyAssets || DEFAULTS.includeBodyAssets).trim(),
  };
}

function normalizeEnum<T extends string>(value: unknown, validValues: readonly T[], fallback: T): T {
  return validValues.includes(value as T) ? (value as T) : fallback;
}

function assertValid<T extends string>(value: string, validValues: readonly T[], label: string): void {
  if (!(validValues as readonly string[]).includes(value)) throw new Error(`${label}配置不正确`);
}

function normalizeLengthPreset(value: unknown): LengthPreset {
  return normalizeEnum(value, LENGTH_PRESETS, 'balanced');
}

function normalizeFactPolicy(value: unknown): FactPolicy {
  return normalizeEnum(value, FACT_POLICIES, 'conservative');
}

function normalizeOutputLanguage(value: unknown): string {
  return normalizeEnum(String(value || DEFAULTS.outputLanguage), OUTPUT_LANGUAGES, DEFAULTS.outputLanguage);
}

function normalizeIncludeBodyAssets(value: unknown): string {
  if (value === true || value === 1 || value === '1') return '1';
  if (value === false || value === 0 || value === '0') return '0';
  return String(value || DEFAULTS.includeBodyAssets).trim();
}

function applyWritingOptions(config: ScribeConfig, options?: WriterWritingOptions): ScribeConfig {
  if (!options) return config;

  return {
    ...config,
    ...(options.stylePostCount !== undefined ? { stylePostCount: String(options.stylePostCount).trim() } : {}),
    ...(options.outputLanguage !== undefined ? { outputLanguage: normalizeOutputLanguage(options.outputLanguage) } : {}),
    ...(options.targetAudience !== undefined ? { targetAudience: String(options.targetAudience).trim() } : {}),
    ...(options.lengthPreset !== undefined ? { lengthPreset: normalizeLengthPreset(options.lengthPreset) } : {}),
    ...(options.factPolicy !== undefined ? { factPolicy: normalizeFactPolicy(options.factPolicy) } : {}),
    ...(options.userPrompt !== undefined ? { userPrompt: String(options.userPrompt).trim() } : {}),
    ...(options.includeBodyAssets !== undefined ? { includeBodyAssets: normalizeIncludeBodyAssets(options.includeBodyAssets) } : {}),
  };
}

function getConfig(options?: Record<string, unknown>): ScribeConfig {
  return normalizeConfig({
    ...DEFAULTS,
    ...parsePluginOption(options?.[`plugin:${PLUGIN_ID}`]),
  });
}

function buildChatCompletionsUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/chat/completions`;
}

function normalizeText(text: string): string {
  return stripTypechoMarkers(text).replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function xmlBlock(name: string, content: string): string {
  return `<${name}>\n${content.trim() || '无'}\n</${name}>`;
}

function buildStyleContext(samples: StyleSample[]): string {
  if (samples.length === 0) {
    return '暂无最近文章样本。';
  }

  return samples.map((sample, index) => [
    `样本 ${index + 1} 标题：${sample.title || '无标题'}`,
    `样本 ${index + 1} 正文片段：${normalizeText(truncateText(sample.text, 1200))}`,
  ].join('\n')).join('\n\n');
}

function buildConfiguredUserPrompt(config: ScribeConfig): string {
  if (!config.userPrompt) {
    return '未配置额外写作要求。';
  }

  return [
    '以下是站点管理员配置的额外写作要求，请在不违背系统约束和事实准确性的前提下遵循：',
    config.userPrompt,
  ].join('\n');
}

function buildWritingProfile(config: ScribeConfig): string {
  const language = config.outputLanguage === 'auto'
    ? '自动判断：优先沿用标题、正文和样本的主要语言。'
    : `固定使用：${config.outputLanguage}`;
  const audience = config.targetAudience
    ? config.targetAudience
    : '未指定，按站点既有文章的读者画像推断。';
  const length = LENGTH_LABELS[config.lengthPreset] ?? LENGTH_LABELS.balanced;
  const factPolicy = config.factPolicy === 'assumptive'
    ? '允许基于常识做低风险推断，但必须避免虚构具体事实、数据、链接和来源。'
    : '保守事实策略：没有在上下文出现或无法确定的具体事实不要写成确定结论。';

  return [
    `输出语言：${language}`,
    `目标读者：${audience}`,
    `篇幅策略：${length}`,
    `事实策略：${factPolicy}`,
  ].join('\n');
}

const MODE_INSTRUCTIONS: Record<WriterMode, (label: string) => string[]> = {
  generate: (label) => [`根据标题和上下文生成一篇完整${label}正文。`, '不要重复输出标题。', '先组织清晰结构，再输出正文。'],
  polish: (label) => [`润色下面这篇${label}，输出润色后的完整正文。`, '重点提升表达清晰度、段落节奏、结构衔接和可读性。', '不得改变原文核心观点、事实、语气边界或 Markdown 语义。'],
  correct: (label) => [`校对这篇${label}，输出校对后的完整正文。`, '修正错别字、语法错误、标点不当、事实矛盾和逻辑断裂。', '保留原文风格、结构、观点和语气，不添加新内容或做润色式改写。'],
  continue: (label) => [
    `根据 <user_adjustment> 中的调整要求，结合 <original_draft> 中的原文和 <current_result> 中的当前结果，输出调整后的完整${label}正文。`,
    '不得改变原文核心观点与事实，仅落实用户的调整要求。',
    '直接输出调整后的完整正文，不要解释改动了什么。',
  ],
};

function buildModeInstruction(mode: WriterMode, typeLabel: string): string {
  return MODE_INSTRUCTIONS[mode](typeLabel).join('\n');
}

function buildOutputContract(mode: WriterMode): string {
  const lines = [
    '只输出最终 Markdown 正文。',
    '不要输出标题、解释、分析过程、计划、检查清单、代码围栏或额外寒暄。',
    '保留合理的 Markdown 链接、图片、引用、列表、脚注和代码块语义。',
    '引用定义和脚注定义统一放在全文末尾。',
    '避免重复段落和重复小标题。',
  ];

  if (mode !== 'generate') {
    lines.push('必须返回完整正文，从正文第一段开始，到正文最后一段结束。');
  }

  return lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

function shouldIncludeBodyAssets(config: ScribeConfig): boolean {
  return config.includeBodyAssets === '1';
}

function buildAssetsContext(assets: ContentAsset[]): string {
  if (assets.length === 0) {
    return '未发现正文图片或附件。';
  }

  return assets.map((asset, index) => {
    const parts = [
      `${index + 1}. ${asset.kind === 'image' ? '图片' : '附件'}：${asset.title || '未命名'}`,
      `URL：${asset.url}`,
      asset.mime ? `类型：${asset.mime}` : '',
      asset.size ? `大小：${asset.size} bytes` : '',
      asset.cid ? `附件 ID：${asset.cid}` : '',
      `来源：${asset.source === 'attachment' ? '附件记录' : '正文引用'}`,
    ].filter(Boolean);
    return parts.join('\n');
  }).join('\n\n');
}

function buildContinueDraftBlock(payload: WriterPayload, typeLabel: string, title: string): string {
  return [
    xmlBlock('original_draft', [
      `content_type: ${typeLabel}`,
      `title: ${title}`,
      payload.originalBody ? `body:\n${payload.originalBody}` : 'body: 无',
    ].join('\n')),
    xmlBlock('current_result', payload.body || '无'),
    xmlBlock('user_adjustment', payload.followUpPrompt || '无'),
  ].join('\n\n');
}

function buildPrompt(
  mode: WriterMode,
  payload: WriterPayload,
  styleSamples: StyleSample[],
  config: ScribeConfig,
  assets: ContentAsset[],
): string {
  const typeLabel = payload.contentType === 'page' ? '页面' : '文章';
  const title = payload.title || '未命名';
  const body = payload.body || '';
  const styleContext = buildStyleContext(styleSamples);
  const configuredUserPrompt = buildConfiguredUserPrompt(config);

  const draftBlock = mode === 'continue'
    ? buildContinueDraftBlock(payload, typeLabel, title)
    : xmlBlock('draft', [
        `content_type: ${typeLabel}`,
        `title: ${title}`,
        body ? `body:\n${body}` : 'body: 无',
      ].join('\n'));

  return [
    xmlBlock('style_samples', styleContext),
    xmlBlock('writing_profile', buildWritingProfile(config)),
    xmlBlock('admin_requirements', configuredUserPrompt),
    shouldIncludeBodyAssets(config) ? xmlBlock('assets', buildAssetsContext(assets)) : '',
    draftBlock,
    xmlBlock('task', buildModeInstruction(mode, typeLabel)),
    xmlBlock('output_contract', buildOutputContract(mode)),
  ].filter(Boolean).join('\n\n');
}

async function readErrorSnippet(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  const message = extractErrorMessageFromText(text);
  return message ? `：${message.slice(0, 200)}` : '';
}

function extractErrorMessageFromText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  try {
    const data = JSON.parse(trimmed) as unknown;
    return extractErrorMessage(data);
  } catch {
    return trimmed.startsWith('{') || trimmed.startsWith('[') ? '' : trimmed;
  }
}

function extractErrorMessage(data: unknown): string {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';

  const record = data as Record<string, unknown>;
  const error = record.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.message === 'string') return errorRecord.message;
    if (typeof errorRecord.msg === 'string') return errorRecord.msg;
    if (typeof errorRecord.code === 'string') return errorRecord.code;
  }

  if (typeof record.message === 'string') return record.message;
  if (typeof record.msg === 'string') return record.msg;
  if (typeof record.detail === 'string') return record.detail;
  return '';
}

function validationHeaders(config: ScribeConfig): HeadersInit {
  return {
    Authorization: `Bearer ${config.apiKey}`,
  };
}

async function validateConfig(settings?: Record<string, unknown>): Promise<ScribeConfig> {
  const config = normalizeConfig(settings);
  if (!config.endpoint || !config.apiKey || !config.model) {
    throw new Error('请填写接口地址、API Key 和模型名称');
  }

  let url: URL;
  try {
    url = new URL(config.endpoint);
  } catch {
    throw new Error('接口地址格式不正确');
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('接口地址必须使用 http 或 https');
  }

  const temperature = Number(config.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error('temperature 必须是 0 到 2 之间的数字');
  }

  const maxTokens = Number(config.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > MAX_OUTPUT_TOKENS) {
    throw new Error(`max tokens 必须是 128 到 ${MAX_OUTPUT_TOKENS} 之间的整数`);
  }

  const stylePostCount = Number(config.stylePostCount);
  if (!Number.isInteger(stylePostCount) || stylePostCount < 0 || stylePostCount > 20) {
    throw new Error('参考历史文章必须是 0 到 20 之间的整数');
  }
  if (!['0', '1'].includes(config.includeBodyAssets)) {
    throw new Error('发送正文图片和附件配置不正确');
  }
  assertValid(config.outputLanguage, OUTPUT_LANGUAGES, '输出语言');
  assertValid(config.lengthPreset, LENGTH_PRESETS, '篇幅策略');
  assertValid(config.factPolicy, FACT_POLICIES, '事实策略');

  // Model availability is checked when the writer action runs. Blocking admin
  // saves on provider latency makes otherwise valid settings impossible to save.
  return config;
}

async function loadStyleSamples(db: Database | undefined, count: number): Promise<StyleSample[]> {
  if (!db || count <= 0) return [];

  const rows = await db
    .select({
      title: schema.contents.title,
      text: schema.contents.text,
    })
    .from(schema.contents)
    .where(and(
      eq(schema.contents.type, 'post'),
      eq(schema.contents.status, 'publish'),
    ))
    .orderBy(desc(schema.contents.created))
    .limit(count);

  return rows.map(row => ({
    title: row.title || '',
    text: row.text || '',
  }));
}

function parsePositiveInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/^<|>$/g, '');
}

function isSkippableUrl(url: string): boolean {
  return !url
    || url.startsWith('#')
    || /^mailto:/i.test(url)
    || /^javascript:/i.test(url)
    || /^tel:/i.test(url);
}

function inferAssetKind(url: string, mime?: string): 'image' | 'file' {
  if (mime?.startsWith('image/')) return 'image';
  return /\.(avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(url) ? 'image' : 'file';
}

function pushBodyAsset(assets: ContentAsset[], title: string, url: string): void {
  const normalizedUrl = normalizeUrl(url);
  if (isSkippableUrl(normalizedUrl)) return;
  assets.push({
    source: 'body',
    kind: inferAssetKind(normalizedUrl),
    title: title.trim(),
    url: normalizedUrl,
  });
}

function extractBodyAssets(body: string): ContentAsset[] {
  const assets: ContentAsset[] = [];

  for (const match of body.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    pushBodyAsset(assets, match[1] || '', match[2] || '');
  }

  for (const match of body.matchAll(/(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    pushBodyAsset(assets, match[1] || '', match[2] || '');
  }

  for (const match of body.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const tag = match[0] || '';
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] || '';
    pushBodyAsset(assets, alt, match[1] || '');
  }

  for (const match of body.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi)) {
    const title = (match[2] || '').replace(/<[^>]+>/g, '').trim();
    pushBodyAsset(assets, title, match[1] || '');
  }

  return assets;
}

function dedupeAssets(assets: ContentAsset[]): ContentAsset[] {
  const seen = new Set<string>();
  const result: ContentAsset[] = [];
  for (const asset of assets) {
    const key = asset.cid ? `cid:${asset.cid}` : `url:${asset.url}`;
    if (!asset.url || seen.has(key)) continue;
    seen.add(key);
    result.push(asset);
  }
  return result.slice(0, 20);
}

async function loadAttachmentAssets(
  db: Database | undefined,
  cid: number,
  attachmentIds: number[],
): Promise<ContentAsset[]> {
  if (!db || (!cid && attachmentIds.length === 0)) return [];

  const conditions = [
    cid ? eq(schema.contents.parent, cid) : undefined,
    attachmentIds.length > 0 ? inArray(schema.contents.cid, attachmentIds) : undefined,
  ].filter(Boolean);

  if (conditions.length === 0) return [];

  const rows = await db
    .select({
      cid: schema.contents.cid,
      title: schema.contents.title,
      text: schema.contents.text,
    })
    .from(schema.contents)
    .where(and(
      eq(schema.contents.type, 'attachment'),
      conditions.length === 1 ? conditions[0] : or(...conditions),
    ))
    .limit(50);

  return rows.map((row): ContentAsset => {
    const meta = parseAttachmentMeta(row.text);
    const url = meta.url || '';
    return {
      source: 'attachment',
      kind: inferAssetKind(url, meta.type),
      title: meta.name || row.title || '',
      url,
      mime: meta.type,
      size: meta.size,
      cid: row.cid,
    };
  }).filter(asset => !!asset.url);
}

async function loadContentAssets(
  db: Database | undefined,
  config: ScribeConfig,
  payload: WriterPayload,
): Promise<ContentAsset[]> {
  if (!shouldIncludeBodyAssets(config)) return [];

  const cid = parsePositiveInt(payload.cid);
  const attachmentIds = Array.isArray(payload.attachmentIds)
    ? [...new Set(payload.attachmentIds.map(parsePositiveInt).filter(Boolean))]
    : [];
  const bodyAssets = extractBodyAssets(payload.body || '');
  const attachmentAssets = await loadAttachmentAssets(db, cid, attachmentIds);
  return dedupeAssets([...bodyAssets, ...attachmentAssets]);
}

function toAbsoluteUrl(url: string, siteUrl?: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!siteUrl || !url.startsWith('/')) return '';
  return `${siteUrl.replace(/\/+$/, '')}${url}`;
}

function buildUserContent(prompt: string, assets: ContentAsset[], siteUrl?: string): string | UserContentPart[] {
  const imageParts = assets
    .filter(asset => asset.kind === 'image')
    .map(asset => toAbsoluteUrl(asset.url, siteUrl))
    .filter(Boolean)
    .slice(0, 8)
    .map(url => ({ type: 'image_url' as const, image_url: { url } }));

  if (imageParts.length === 0) {
    return prompt;
  }

  return [
    { type: 'text', text: prompt },
    ...imageParts,
  ];
}

function buildChatCompletionPayload(
  config: ScribeConfig,
  mode: WriterMode,
  payload: WriterPayload,
  styleSamples: StyleSample[],
  assets: ContentAsset[],
  siteUrl?: string,
  stream = false,
): Record<string, unknown> {
  return {
    model: config.model,
    temperature: Number(config.temperature) || 0.7,
    max_tokens: Number(config.maxTokens) || Number(DEFAULTS.maxTokens),
    stream,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserContent(buildPrompt(mode, payload, styleSamples, config, assets), assets, siteUrl) },
    ],
  };
}

async function callLLM(
  config: ScribeConfig,
  mode: WriterMode,
  payload: WriterPayload,
  styleSamples: StyleSample[],
  assets: ContentAsset[],
  siteUrl?: string,
): Promise<string> {
  if (!config.endpoint || !config.apiKey || !config.model) {
    throw new Error('请先完整配置接口地址、API Key 和模型名称');
  }

  const response = await fetchWithTimeout(
    buildChatCompletionsUrl(config.endpoint),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...validationHeaders(config),
      },
      body: JSON.stringify(buildChatCompletionPayload(config, mode, payload, styleSamples, assets, siteUrl)),
    },
    LLM_REQUEST_TIMEOUT_MS,
    'LLM 请求超时，请稍后重试',
  );

  if (!response.ok) {
    const suffix = await readErrorSnippet(response);
    throw new Error(`LLM 请求失败 (${response.status})${suffix}`);
  }

  const data = await response.json() as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM 返回格式不正确');
  }

  return content.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function createTextStreamFromLLM(response: Response): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error('LLM 未返回可读取的流');
  }

  let buffer = '';
  let outputStarted = false;

  function cleanFirstChunk(content: string): string {
    if (outputStarted) return content;
    outputStarted = true;
    return content.replace(/^```(?:markdown|md)?\s*/i, '');
  }

  function parseLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return '';
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return '';

    try {
      const chunk = JSON.parse(data) as ChatCompletionStreamChunk;
      return cleanFirstChunk(chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content || '');
    } catch {
      return '';
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const content = parseLine(line);
          if (content) {
            controller.enqueue(encoder.encode(content));
            return;
          }
          continue;
        }

        const { done, value } = await reader.read();
        if (done) {
          const tail = parseLine(buffer);
          if (tail) controller.enqueue(encoder.encode(tail.replace(/\s*```$/i, '')));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel() {
      void reader.cancel();
    },
  });
}

async function callLLMStream(
  config: ScribeConfig,
  mode: WriterMode,
  payload: WriterPayload,
  styleSamples: StyleSample[],
  assets: ContentAsset[],
  siteUrl?: string,
): Promise<Response> {
  if (!config.endpoint || !config.apiKey || !config.model) {
    throw new Error('请先完整配置接口地址、API Key 和模型名称');
  }

  const response = await fetchWithTimeout(
    buildChatCompletionsUrl(config.endpoint),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(buildChatCompletionPayload(config, mode, payload, styleSamples, assets, siteUrl, true)),
    },
    LLM_REQUEST_TIMEOUT_MS,
    'LLM 请求超时，请稍后重试',
  );

  if (!response.ok) {
    const suffix = await readErrorSnippet(response);
    throw new Error(`LLM 请求失败 (${response.status})${suffix}`);
  }

  return new Response(createTextStreamFromLLM(response), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Typecho-Plugin-Stream': '1',
    },
  });
}

const POST_EDITOR_HTML = editorHtml('post');
const PAGE_EDITOR_HTML = editorHtml('page');

function editorHtml(contentType: ContentType): string {
  return `
<style>
#wmd-scribe-button .typecho-scribe-toolbar-icon,
.typecho-scribe-fallback-btn .typecho-scribe-toolbar-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 11px;
  font-weight: 700;
  color: #666;
}
#wmd-scribe-button {
  position: relative;
}
#wmd-scribe-button[aria-disabled="true"] {
  opacity: .5;
  cursor: default;
}
#wmd-scribe-button .typecho-scribe-menu span {
  display: unset;
  width: unset;
  height: unset;
}

.typecho-scribe-menu {
  display: none;
  position: absolute;
  top: 28px;
  left: 0;
  width: 272px;
  max-height: min(560px, calc(100vh - 160px));
  overflow-y: auto;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  padding: 8px;
  background: #fff;
  border: 1px solid #d9d9d9;
  border-radius: 3px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, .12);
  z-index: 30;
}
.typecho-scribe-menu[aria-hidden="false"] {
  display: flex;
}
.typecho-scribe-menu-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.typecho-scribe-menu-button svg {
  flex-shrink: 0;
}
.typecho-scribe-menu-button:hover,
.typecho-scribe-menu-button:focus {
  background: #f0f0f0;
  color: #222;
  outline: none;
}
.typecho-scribe-menu-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  border-top: 1px dashed #d9d9d9;
  padding-top: 8px;
}
.typecho-scribe-menu-button[aria-disabled="true"] {
  opacity: .5;
  cursor: default;
}

.typecho-scribe-writing-settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.typecho-scribe-setting {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.typecho-scribe-setting > label {
  font-size: 12px;
  color: #555;
}
.typecho-scribe-setting textarea,
.typecho-scribe-setting input[type="text"],
.typecho-scribe-setting select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  border: 1px solid #d9d9d9;
  border-radius: 2px;
  background: #fff;
  color: #333;
  font: 13px/1.5 inherit;
}
.typecho-scribe-setting textarea {
  min-height: 64px;
  padding: 5px 7px;
  resize: vertical;
}
.typecho-scribe-setting input[type="text"] {
  height: 28px;
  padding: 4px 7px;
}
.typecho-scribe-setting select {
  height: 28px;
  padding: 2px 6px;
}
.typecho-scribe-setting textarea:focus,
.typecho-scribe-setting input[type="text"]:focus,
.typecho-scribe-setting select:focus {
  border-color: #467b96;
  outline: none;
}
.typecho-scribe-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #333;
  cursor: pointer;
}
.typecho-scribe-advanced {
  border-top: 1px dashed #d9d9d9;
  padding-top: 8px;
}
.typecho-scribe-advanced summary {
  cursor: pointer;
  font-size: 12px;
  color: #666;
  user-select: none;
}
.typecho-scribe-advanced[open] summary {
  color: #222;
}
.typecho-scribe-advanced-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding-top: 8px;
}
.typecho-scribe-advanced-fields .typecho-scribe-setting-wide {
  grid-column: 1 / -1;
}

.typecho-scribe-modal {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 1000;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0, 0, 0, .45);
}
.typecho-scribe-modal[aria-hidden="false"] {
  display: flex;
}
.typecho-scribe-modal-dialog {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(860px, 100%);
  max-height: calc(100vh - 40px);
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, .25);
}
.typecho-scribe-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid #e5e5e5;
}
.typecho-scribe-modal-title {
  font-size: 15px;
  font-weight: 600;
  color: #222;
}
.typecho-scribe-modal-tabs {
  display: flex;
  gap: 2px;
  margin-left: auto;
}
.typecho-scribe-modal-tab {
  border: 0;
  background: none;
  padding: 4px 10px;
  font-size: 13px;
  line-height: 1;
  color: #666;
  cursor: pointer;
  border-radius: 2px;
}
.typecho-scribe-modal-tab:hover,
.typecho-scribe-modal-tab:focus {
  background: #f0f0f0;
  color: #222;
  outline: none;
}
.typecho-scribe-modal-tab.active {
  background: #467b96;
  color: #fff;
}
.typecho-scribe-modal-close {
  border: 0;
  background: none;
  padding: 2px 8px;
  font-size: 20px;
  line-height: 1;
  color: #888;
  cursor: pointer;
}
.typecho-scribe-modal-close:hover {
  color: #333;
}
.typecho-scribe-modal-body {
  position: relative;
  flex: 0 0 auto;
  height: 42vh;
  min-height: 200px;
  margin: 12px 16px 0;
}
.typecho-scribe-modal-write {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  resize: none;
  padding: 14px 16px;
  border: 1px solid #e5e5e5;
  border-radius: 3px;
  background: #fff;
  color: #333;
  font: 13px/1.7 inherit;
  white-space: pre-wrap;
  word-break: break-word;
}
.typecho-scribe-modal-write:focus {
  border-color: #467b96;
  outline: none;
}
.typecho-scribe-modal-preview {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  padding: 14px 16px;
  border: 1px solid #e5e5e5;
  border-radius: 3px;
  background: #fff;
  word-wrap: break-word;
  overflow-wrap: break-word;
  font-size: 13px;
  line-height: 1.7;
  color: #333;
}
.typecho-scribe-modal-compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  height: 100%;
}
.typecho-scribe-modal-compare-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid #e5e5e5;
  border-radius: 3px;
  background: #fff;
  overflow: hidden;
}
.typecho-scribe-modal-compare-label {
  padding: 6px 10px;
  font-size: 12px;
  color: #666;
  border-bottom: 1px solid #e5e5e5;
  background: #fafafa;
  user-select: none;
}
.typecho-scribe-modal-compare-content {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
  word-wrap: break-word;
  overflow-wrap: break-word;
  font-size: 13px;
  line-height: 1.7;
  color: #333;
}
.typecho-scribe-modal-compare-content.typecho-scribe-modal-compare-empty {
  color: #999;
}
.typecho-scribe-tab-hidden {
  display: none !important;
}
.typecho-scribe-modal-followup {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 16px;
}
.typecho-scribe-modal-followup-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 56px;
  max-height: 120px;
  padding: 6px 8px;
  border: 1px solid #d9d9d9;
  border-radius: 2px;
  resize: vertical;
  background: #fff;
  color: #333;
  font: 13px/1.5 inherit;
}
.typecho-scribe-modal-followup-input:focus {
  border-color: #467b96;
  outline: none;
}
.typecho-scribe-modal-followup-input::placeholder {
  color: #999;
}
.typecho-scribe-modal-followup-hint {
  font-size: 12px;
  color: #999;
  user-select: none;
}
.typecho-scribe-modal-status {
  flex: 1;
  font-size: 12px;
  color: #666;
}
.typecho-scribe-modal-status-error {
  color: #c33;
}
.typecho-scribe-modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #e5e5e5;
}
.typecho-scribe-modal-confirm[disabled] {
  opacity: .5;
  cursor: default;
}

.typecho-scribe-fallback-btn svg {
  display: block;
  width: 16px;
  height: 16px;
}
</style>
<div class="typecho-scribe" data-content-type="${contentType}" hidden>
  <span class="typecho-scribe-fallback-actions"></span>
</div>
<div class="typecho-scribe-modal" aria-hidden="true">
  <div class="typecho-scribe-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="typecho-scribe-modal-title">
    <div class="typecho-scribe-modal-header">
      <span class="typecho-scribe-modal-title" id="typecho-scribe-modal-title">AI 预览</span>
      <div class="typecho-scribe-modal-tabs" role="tablist" aria-label="预览模式">
        <button type="button" class="typecho-scribe-modal-tab active" data-scribe-tab="write" role="tab" aria-selected="true">撰写</button>
        <button type="button" class="typecho-scribe-modal-tab" data-scribe-tab="preview" role="tab" aria-selected="false">预览</button>
        <button type="button" class="typecho-scribe-modal-tab" data-scribe-tab="compare" role="tab" aria-selected="false">比对</button>
      </div>
      <button type="button" class="typecho-scribe-modal-close" aria-label="关闭预览">&times;</button>
    </div>
    <div class="typecho-scribe-modal-body">
      <textarea class="typecho-scribe-modal-write mono" spellcheck="false" aria-label="AI 生成内容"></textarea>
      <div class="typecho-scribe-modal-preview wmd-preview typecho-scribe-tab-hidden" role="status" aria-live="polite"></div>
      <div class="typecho-scribe-modal-compare typecho-scribe-tab-hidden">
        <div class="typecho-scribe-modal-compare-pane">
          <div class="typecho-scribe-modal-compare-label">原文</div>
          <div class="typecho-scribe-modal-compare-content wmd-preview typecho-scribe-modal-compare-original"></div>
        </div>
        <div class="typecho-scribe-modal-compare-pane">
          <div class="typecho-scribe-modal-compare-label">AI 生成</div>
          <div class="typecho-scribe-modal-compare-content wmd-preview typecho-scribe-modal-compare-generated"></div>
        </div>
      </div>
    </div>
    <div class="typecho-scribe-modal-followup">
      <textarea class="typecho-scribe-modal-followup-input" placeholder="输入调整要求，发送后 AI 将结合原文与当前结果继续调整，结果实时显示在上方"></textarea>
      <span class="typecho-scribe-modal-followup-hint">Enter 发送 · Shift+Enter 换行</span>
    </div>
    <div class="typecho-scribe-modal-footer">
      <div class="typecho-scribe-modal-status" role="status" aria-live="polite"></div>
      <button type="button" class="btn typecho-scribe-modal-cancel">取消</button>
      <button type="button" class="btn primary typecho-scribe-modal-confirm" disabled>确定</button>
    </div>
  </div>
</div>
<script is:inline>
(function() {
  if (window.__typechoScribeReady) return;
  window.__typechoScribeReady = true;

  function clearAdminNotice() {
    var notice = document.querySelector('.typecho-scribe-notice');
    if (notice && notice.parentNode) {
      notice.parentNode.removeChild(notice);
    }
  }

  function showAdminNotice(message, type) {
    clearAdminNotice();

    var notice = document.createElement('div');
    var isError = type === 'error';
    notice.className = 'typecho-scribe-notice typecho-option-tabs notice typecho-dismissible ' + (isError ? 'notice-error' : 'notice-success');
    notice.style.padding = '10px 15px';
    notice.style.marginBottom = '20px';
    notice.style.borderRadius = '3px';
    notice.style.background = isError ? '#ffeaea' : '#e7f5e7';
    notice.style.color = isError ? '#c33' : '#3a3';
    notice.setAttribute('role', isError ? 'alert' : 'status');

    var paragraph = document.createElement('p');
    paragraph.textContent = message || 'AI 写作失败';
    paragraph.style.margin = '0';
    notice.appendChild(paragraph);

    var closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'typecho-notice-close';
    closeButton.setAttribute('aria-label', '关闭提示');
    closeButton.innerHTML = '&times;';
    notice.appendChild(closeButton);

    var main = document.querySelector('.typecho-page-main');
    if (main) {
      main.insertBefore(notice, main.firstChild);
      if (!notice.closest('[class*="col-"]')) {
        notice.classList.add('col-mb-12');
      }
    } else {
      document.body.insertBefore(notice, document.body.firstChild);
    }

    notice.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  var SCRIBE_ICON = '<span class="typecho-scribe-toolbar-icon" aria-hidden="true">AI</span>';
  var MODE_ICONS = {
    generate: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    polish: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    correct: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 10 2 2 4-4"/><rect width="20" height="20" x="2" y="2" rx="4" opacity=".25"/><path d="M20.5 2.5 15 20 9 17l-5.5 3L6 14Z"/></svg>'
  };
  var scribeButtons = [];
  var MODE_LABELS = { generate: '生成', polish: '润色', correct: '纠错' };
  var WRITING_STORAGE_KEY = 'typecho-scribe-writing-settings';
  var WRITING_DEFAULTS = {
    userPrompt: '',
    outputLanguage: 'auto',
    stylePostCount: '5',
    targetAudience: '',
    lengthPreset: 'balanced',
    factPolicy: 'conservative',
    includeBodyAssets: false
  };
  var OUTPUT_LANGUAGE_OPTIONS = ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko'];
  var STYLE_POST_COUNT_OPTIONS = ['0', '5', '10'];
  var LENGTH_PRESET_OPTIONS = ['concise', 'balanced', 'detailed'];
  var FACT_POLICY_OPTIONS = ['conservative', 'assumptive'];

  function validStoredValue(value, options, fallback) {
    return options.indexOf(String(value)) >= 0 ? String(value) : fallback;
  }

  function loadWritingSettings() {
    var defaults = Object.assign({}, WRITING_DEFAULTS);
    try {
      var parsed = JSON.parse(window.localStorage.getItem(WRITING_STORAGE_KEY) || '{}');
      if (!parsed || typeof parsed !== 'object') return defaults;
      return {
        userPrompt: typeof parsed.userPrompt === 'string' ? parsed.userPrompt : defaults.userPrompt,
        outputLanguage: validStoredValue(parsed.outputLanguage, OUTPUT_LANGUAGE_OPTIONS, defaults.outputLanguage),
        stylePostCount: validStoredValue(parsed.stylePostCount, STYLE_POST_COUNT_OPTIONS, defaults.stylePostCount),
        targetAudience: typeof parsed.targetAudience === 'string' ? parsed.targetAudience : defaults.targetAudience,
        lengthPreset: validStoredValue(parsed.lengthPreset, LENGTH_PRESET_OPTIONS, defaults.lengthPreset),
        factPolicy: validStoredValue(parsed.factPolicy, FACT_POLICY_OPTIONS, defaults.factPolicy),
        includeBodyAssets: parsed.includeBodyAssets === true
      };
    } catch (error) {
      return defaults;
    }
  }

  function saveWritingSettings(settings) {
    try {
      window.localStorage.setItem(WRITING_STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      // localStorage may be unavailable in hardened admin contexts.
    }
  }

  function collectWritingSettings(container) {
    var settings = loadWritingSettings();
    if (!container) return settings;

    function fieldValue(name, fallback) {
      var field = container.querySelector('[data-scribe-setting="' + name + '"]');
      return field ? field.value : fallback;
    }

    var checkbox = container.querySelector('[data-scribe-setting="includeBodyAssets"]');
    return {
      userPrompt: fieldValue('userPrompt', settings.userPrompt),
      outputLanguage: validStoredValue(fieldValue('outputLanguage', settings.outputLanguage), OUTPUT_LANGUAGE_OPTIONS, settings.outputLanguage),
      stylePostCount: validStoredValue(fieldValue('stylePostCount', settings.stylePostCount), STYLE_POST_COUNT_OPTIONS, settings.stylePostCount),
      targetAudience: fieldValue('targetAudience', settings.targetAudience),
      lengthPreset: validStoredValue(fieldValue('lengthPreset', settings.lengthPreset), LENGTH_PRESET_OPTIONS, settings.lengthPreset),
      factPolicy: validStoredValue(fieldValue('factPolicy', settings.factPolicy), FACT_POLICY_OPTIONS, settings.factPolicy),
      includeBodyAssets: checkbox ? checkbox.checked : settings.includeBodyAssets
    };
  }

  function applyWritingSettings(root, settings) {
    if (!root) return;
    root.querySelectorAll('[data-scribe-setting]').forEach(function(field) {
      var name = field.getAttribute('data-scribe-setting');
      if (name === 'includeBodyAssets') {
        field.checked = settings.includeBodyAssets === true;
        return;
      }
      if (settings[name] !== undefined) field.value = settings[name];
    });
  }

  function modeLabel(mode) {
    return MODE_LABELS[mode] || MODE_LABELS.generate;
  }

  var previewState = {
    open: false,
    box: null,
    mode: 'generate',
    tab: 'write',
    oldText: '',
    currentText: '',
    followUpPrompt: '',
    streaming: false,
    error: false,
    userEdited: false,
    controller: null
  };

  function escapeHtmlText(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMarkdown(text) {
    var source = String(text == null ? '' : text);
    if (!source) return '<p class="typecho-scribe-modal-compare-empty">（无内容）</p>';
    if (window.HyperDown && window.DOMPurify) {
      try {
        var converter = new window.HyperDown();
        converter.enableHtml(true);
        converter.enableLine(true);
        return window.DOMPurify.sanitize(converter.makeHtml(source), { USE_PROFILES: { html: true } });
      } catch (error) {
        // Fall through to plain-text rendering.
      }
    }
    return '<p>' + escapeHtmlText(source).replace(/\\n/g, '<br>') + '</p>';
  }

  function setModalTab(tab) {
    previewState.tab = tab;
    var modal = document.querySelector('.typecho-scribe-modal');
    if (!modal) return;
    modal.querySelectorAll('.typecho-scribe-modal-tab').forEach(function(button) {
      var isActive = button.getAttribute('data-scribe-tab') === tab;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    var writeEl = modal.querySelector('.typecho-scribe-modal-write');
    var previewEl = modal.querySelector('.typecho-scribe-modal-preview');
    var compareEl = modal.querySelector('.typecho-scribe-modal-compare');
    writeEl.classList.toggle('typecho-scribe-tab-hidden', tab !== 'write');
    previewEl.classList.toggle('typecho-scribe-tab-hidden', tab !== 'preview');
    compareEl.classList.toggle('typecho-scribe-tab-hidden', tab !== 'compare');
    renderModalViews();
  }

  function renderModalViews() {
    var modal = document.querySelector('.typecho-scribe-modal');
    if (!modal || !previewState.open) return;
    var writeEl = modal.querySelector('.typecho-scribe-modal-write');
    var previewEl = modal.querySelector('.typecho-scribe-modal-preview');
    var originalEl = modal.querySelector('.typecho-scribe-modal-compare-original');
    var generatedEl = modal.querySelector('.typecho-scribe-modal-compare-generated');
    // 用户已开始手动编辑时，以 textarea 内容为准，流式内容不再覆盖。
    var text = previewState.userEdited ? writeEl.value : previewState.currentText;
    if (!previewState.userEdited) {
      writeEl.value = text;
    }
    previewEl.innerHTML = renderMarkdown(text);
    originalEl.innerHTML = renderMarkdown(previewState.oldText);
    generatedEl.innerHTML = renderMarkdown(text);
  }

  function scrollActiveViewToBottom() {
    var modal = document.querySelector('.typecho-scribe-modal');
    if (!modal) return;
    var el = modal.querySelector('.typecho-scribe-modal-write:not(.typecho-scribe-tab-hidden)')
      || modal.querySelector('.typecho-scribe-modal-preview:not(.typecho-scribe-tab-hidden)')
      || modal.querySelector('.typecho-scribe-modal-compare-generated');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function currentTaskLabel() {
    return previewState.followUpPrompt ? '调整' : modeLabel(previewState.mode);
  }

  function updateModalControls() {
    var confirmBtn = document.querySelector('.typecho-scribe-modal-confirm');
    var writeEl = document.querySelector('.typecho-scribe-modal-write');
    var hasText = previewState.userEdited
      ? !!writeEl.value.trim()
      : !!previewState.currentText;
    var canAct = !previewState.streaming && !previewState.error && hasText;
    confirmBtn.disabled = !canAct;
  }

  function setModalStreaming(streaming, label) {
    var statusEl = document.querySelector('.typecho-scribe-modal-status');
    if (streaming) {
      statusEl.textContent = label || 'AI 正在生成...';
      statusEl.classList.remove('typecho-scribe-modal-status-error');
      statusEl.classList.add('loading');
    } else {
      statusEl.classList.remove('loading');
    }
    updateModalControls();
  }

  function showModalStatus(message) {
    var statusEl = document.querySelector('.typecho-scribe-modal-status');
    statusEl.textContent = message || '';
    statusEl.classList.remove('typecho-scribe-modal-status-error');
    statusEl.classList.remove('loading');
    updateModalControls();
  }

  function showModalError(message) {
    var statusEl = document.querySelector('.typecho-scribe-modal-status');
    statusEl.textContent = message || 'AI 写作失败';
    statusEl.classList.add('typecho-scribe-modal-status-error');
    statusEl.classList.remove('loading');
    updateModalControls();
  }

  function openPreviewModal(mode) {
    var modal = document.querySelector('.typecho-scribe-modal');
    modal.querySelector('.typecho-scribe-modal-title').textContent = 'AI ' + modeLabel(mode) + '预览';
    modal.setAttribute('aria-hidden', 'false');
    previewState.open = true;
    previewState.userEdited = false;
    closeScribeMenus();
    setModalTab('write');
  }

  function closePreviewModal(abort) {
    if (!previewState.open) return;
    if (abort && previewState.controller) {
      previewState.controller.abort();
    }
    var modal = document.querySelector('.typecho-scribe-modal');
    modal.setAttribute('aria-hidden', 'true');
    modal.querySelector('.typecho-scribe-modal-write').value = '';
    modal.querySelector('.typecho-scribe-modal-preview').innerHTML = '';
    modal.querySelector('.typecho-scribe-modal-compare-original').innerHTML = '';
    modal.querySelector('.typecho-scribe-modal-compare-generated').innerHTML = '';
    modal.querySelector('.typecho-scribe-modal-followup-input').value = '';
    modal.querySelector('.typecho-scribe-modal-status').textContent = '';
    modal.querySelector('.typecho-scribe-modal-status').classList.remove('typecho-scribe-modal-status-error');
    modal.querySelector('.typecho-scribe-modal-status').classList.remove('loading');
    previewState.open = false;
    previewState.controller = null;
    previewState.userEdited = false;
  }

  function mergeAiCompletion(oldText, streamedText, mode) {
    var fence = String.fromCharCode(96) + '{3}';
    var fenceStart = new RegExp('^\\\\s*' + fence + '(?:markdown|md)?\\\\s*', 'i');
    var fenceEnd = new RegExp('\\\\s*' + fence + '\\\\s*$', 'i');
    var cleaned = (streamedText || '').replace(fenceStart, '').replace(fenceEnd, '').trim();
    if (!oldText.trim() || mode === 'generate') return cleaned;
    if (!cleaned) return oldText;

    return mergeFullRewrite(oldText, cleaned);
  }

  function mergeFullRewrite(oldText, rewrittenText) {
    var oldParts = splitTrailingReferenceBlock(oldText);
    var rewrittenParts = splitTrailingReferenceBlock(rewrittenText);
    var body = rewrittenParts.body || rewrittenText;
    var refs = mergeReferenceBlocks(oldParts.refs, rewrittenParts.refs);

    if (!looksLikeCompleteRewrite(oldParts.body || oldText, body)) {
      body = joinMarkdownBlocks(oldParts.body || oldText, body);
    }

    return joinMarkdownBlocks(body, refs);
  }

  function looksLikeCompleteRewrite(oldBody, rewrittenBody) {
    var oldNormalized = normalizeMarkdownBody(oldBody);
    var rewrittenNormalized = normalizeMarkdownBody(rewrittenBody);
    if (oldNormalized.length < 30) return true;
    if (rewrittenNormalized.indexOf(oldNormalized.slice(0, Math.min(120, oldNormalized.length))) >= 0) return true;

    var oldHeadings = markdownHeadings(oldBody);
    if (oldHeadings.length > 0) {
      var rewrittenHeadings = markdownHeadings(rewrittenBody);
      if (rewrittenHeadings.indexOf(oldHeadings[0]) >= 0 && rewrittenNormalized.length >= oldNormalized.length * 0.6) {
        return true;
      }
    }

    var anchors = significantMarkdownLines(oldBody).slice(0, 6);
    if (anchors.length === 0) return rewrittenNormalized.length >= oldNormalized.length * 0.6;

    var hits = 0;
    anchors.forEach(function(line) {
      if (rewrittenNormalized.indexOf(line) >= 0) hits += 1;
    });
    return hits >= Math.min(2, anchors.length) && rewrittenNormalized.length >= oldNormalized.length * 0.6;
  }

  function normalizeMarkdownBody(markdown) {
    return String(markdown || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  }

  function significantMarkdownLines(markdown) {
    return String(markdown || '')
      .split('\\n')
      .map(normalizeMarkdownBody)
      .filter(function(line) {
        return line.length >= 12 && !isReferenceDefinitionLine(line);
      });
  }

  function markdownHeadings(markdown) {
    return String(markdown || '')
      .split('\\n')
      .map(function(line) {
        var match = String(line || '').match(/^\\s{0,3}#{1,6}\\s+(.+?)\\s*#*\\s*$/);
        return match ? match[1].trim().toLowerCase() : '';
      })
      .filter(Boolean);
  }

  function splitTrailingReferenceBlock(markdown) {
    var normalized = String(markdown || '').replace(/\\s+$/, '');
    if (!normalized) return { body: '', refs: '' };

    var lines = normalized.split('\\n');
    var i = lines.length - 1;
    while (i >= 0 && !lines[i].trim()) i -= 1;

    var end = i;
    var sawReference = false;
    while (i >= 0) {
      var line = lines[i];
      if (!line.trim()) {
        i -= 1;
        continue;
      }
      if (isReferenceDefinitionLine(line)) {
        sawReference = true;
        i -= 1;
        continue;
      }
      if (isReferenceContinuationLine(line)) {
        i -= 1;
        continue;
      }
      break;
    }

    if (!sawReference) return { body: normalized, refs: '' };
    return {
      body: lines.slice(0, i + 1).join('\\n').replace(/\\s+$/, ''),
      refs: lines.slice(i + 1, end + 1).join('\\n').trim(),
    };
  }

  function isReferenceDefinitionLine(line) {
    return /^\\s{0,3}\\[(?:\\^?[^\\]]+)\\]:\\s+\\S/.test(line);
  }

  function isReferenceContinuationLine(line) {
    return /^\\s{4,}\\S/.test(line);
  }

  function joinMarkdownBlocks(first, second) {
    var left = String(first || '').replace(/\\s+$/, '');
    var right = String(second || '').replace(/^\\s+/, '').replace(/\\s+$/, '');
    if (!left) return right;
    if (!right) return left;
    return left + '\\n\\n' + right;
  }

  function mergeReferenceBlocks(first, second) {
    var merged = [];
    var seen = {};
    appendReferenceLines(merged, seen, first);
    appendReferenceLines(merged, seen, second);
    return merged.join('\\n').trim();
  }

  function appendReferenceLines(merged, seen, block) {
    String(block || '').split('\\n').forEach(function(line) {
      var key = referenceKey(line);
      if (key && seen[key]) return;
      if (key) seen[key] = true;
      if (line.trim() || merged.length > 0) merged.push(line);
    });
  }

  function referenceKey(line) {
    var match = String(line || '').match(/^\\s{0,3}\\[((?:\\^)?[^\\]]+)\\]:/);
    return match ? match[1].trim().toLowerCase() : '';
  }

  function extractActionError(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;
    if (typeof data.error === 'string') return data.error;
    if (data.error && typeof data.error === 'object') {
      if (typeof data.error.message === 'string') return data.error.message;
      if (typeof data.error.msg === 'string') return data.error.msg;
      if (typeof data.error.code === 'string') return data.error.code;
    }
    if (typeof data.message === 'string') return data.message;
    if (typeof data.msg === 'string') return data.msg;
    if (typeof data.detail === 'string') return data.detail;
    return '';
  }

  function extractActionErrorFromText(text) {
    var trimmed = String(text || '').trim();
    if (!trimmed) return '';
    try {
      return extractActionError(JSON.parse(trimmed));
    } catch (error) {
      return trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[' ? '' : trimmed;
    }
  }

  async function readActionError(response) {
    var text = await response.text().catch(function() { return ''; });
    return extractActionErrorFromText(text) || response.statusText || 'AI 写作失败';
  }

  async function streamIntoPreview(response) {
    if (!response.body || !window.TextDecoder) {
      var data = await response.json().catch(function() { return {}; });
      if (!response.ok || !data.success) throw new Error(extractActionError(data) || 'AI 写作失败');
      previewState.currentText = data.content || '';
      renderModalViews();
      scrollActiveViewToBottom();
      return;
    }

    if (!response.ok) {
      throw new Error(await readActionError(response));
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var nextText = '';
    for (;;) {
      var result = await reader.read();
      if (result.done) break;
      nextText += decoder.decode(result.value, { stream: true });
      previewState.currentText = nextText;
      renderModalViews();
      scrollActiveViewToBottom();
    }

    var tail = decoder.decode();
    if (tail) {
      nextText += tail;
    }
    previewState.currentText = nextText;
    renderModalViews();
    scrollActiveViewToBottom();
  }

  function buildActionPayload(csrfToken) {
    var writeEl = document.querySelector('.typecho-scribe-modal-write');
    var body = writeEl && writeEl.value.trim()
      ? writeEl.value
      : (previewState.currentText || previewState.oldText);
    var payload = {
      contentType: previewState.box.getAttribute('data-content-type') || 'post',
      title: (document.getElementById('title') || {}).value || '',
      body: body,
      cid: (document.querySelector('input[name="cid"]') || {}).value || '',
      attachmentIds: Array.prototype.slice.call(document.querySelectorAll('input[name="attachment[]"]')).map(function(input) {
        return input.value || '';
      }),
      writingOptions: collectWritingSettings(previewState.box.querySelector('.typecho-scribe-menu') || previewState.box)
    };
    if (previewState.followUpPrompt) {
      payload.originalBody = previewState.oldText;
      payload.followUpPrompt = previewState.followUpPrompt;
    }
    return {
      _: csrfToken,
      plugin: '${PLUGIN_ID}',
      action: previewState.followUpPrompt ? 'continue' : previewState.mode,
      payload: payload
    };
  }

  async function startStream() {
    var csrf = document.querySelector('input[name="_"]');
    if (!previewState.open || !csrf) return;

    // 先构建请求载荷：body 取当前 textarea 内容（上次 AI 结果或用户编辑后的内容），
    // 再清空展示区开始新一轮流式生成，避免 continue 模式把原文误当当前结果发送。
    var requestBody = JSON.stringify(buildActionPayload(csrf.value));
    var writeEl = document.querySelector('.typecho-scribe-modal-write');
    writeEl.value = '';
    previewState.currentText = '';
    previewState.userEdited = false;
    previewState.streaming = true;
    previewState.error = false;
    setModalStreaming(true, 'AI 正在' + currentTaskLabel() + '...');
    previewState.controller = new AbortController();

    try {
      var response = await fetch('/api/admin/plugin-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: previewState.controller.signal,
        body: requestBody
      });
      await streamIntoPreview(response);
      var hasResult = previewState.userEdited
        ? !!writeEl.value.trim()
        : !!previewState.currentText;
      if (!hasResult && (previewState.oldText.trim() !== '' || previewState.followUpPrompt)) {
        previewState.error = true;
        showModalError('AI 未返回内容');
        return;
      }
      showModalStatus(currentTaskLabel() + '完成，请预览后点击「确定」插入编辑器。');
    } catch (error) {
      if (!previewState.open || (error && error.name === 'AbortError')) return;
      previewState.error = true;
      showModalError(error && error.message ? error.message : 'AI 写作失败');
    } finally {
      previewState.streaming = false;
      previewState.controller = null;
      updateModalControls();
    }
  }

  function sendFollowUp() {
    if (!previewState.open || previewState.streaming || previewState.error) return;
    var input = document.querySelector('.typecho-scribe-modal-followup-input');
    var prompt = input.value.trim();
    if (!prompt) return;
    previewState.followUpPrompt = prompt;
    input.value = '';
    startStream();
  }

  function confirmInsert() {
    if (!previewState.open || previewState.streaming || previewState.error) return;
    var writeEl = document.querySelector('.typecho-scribe-modal-write');
    if (!writeEl.value.trim() && !previewState.currentText) return;
    var text = document.getElementById('text');
    // 用户手动编辑过，则直接采用 textarea 内容；否则走智能合并。
    var finalText = previewState.userEdited
      ? writeEl.value
      : mergeAiCompletion(previewState.oldText, writeEl.value || previewState.currentText, previewState.mode);
    text.value = finalText;
    text.dispatchEvent(new Event('input', { bubbles: true }));
    if (window.jQuery) window.jQuery(text).trigger('input');
    var mode = previewState.mode;
    closePreviewModal(false);
    showAdminNotice('AI ' + modeLabel(mode) + '完成', 'success');
  }

  async function runScribe(box, button, requestedMode) {
    if (button && button.getAttribute('aria-disabled') === 'true') return;

    var title = document.getElementById('title');
    var text = document.getElementById('text');
    var csrf = document.querySelector('input[name="_"]');
    if (!box || !title || !text || !csrf) return;

    var oldText = text.value || '';
    var hasText = oldText.trim() !== '';
    var mode;
    if (requestedMode) {
      if ((requestedMode === 'polish' || requestedMode === 'correct') && !hasText) {
        showAdminNotice('请先输入正文，再使用 AI ' + modeLabel(requestedMode), 'error');
        return;
      }
      mode = requestedMode;
    } else {
      mode = 'generate';
    }

    clearAdminNotice();
    previewState.box = box;
    previewState.mode = mode;
    previewState.oldText = oldText;
    previewState.currentText = '';
    previewState.followUpPrompt = '';
    previewState.error = false;
    openPreviewModal(mode);
    await startStream();
  }

  var scribeMenuOpen = false;

  function closeScribeMenus() {
    if (!scribeMenuOpen) return;
    scribeMenuOpen = false;
    document.querySelectorAll('.typecho-scribe-menu').forEach(function(menu) {
      menu.setAttribute('aria-hidden', 'true');
    });
    document.querySelectorAll('.typecho-scribe-menu-trigger').forEach(function(trigger) {
      trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function toggleScribeMenu(trigger) {
    if (!trigger || trigger.getAttribute('aria-disabled') === 'true') return;
    var menu = trigger.querySelector('.typecho-scribe-menu');
    if (!menu) return;
    var willOpen = menu.getAttribute('aria-hidden') !== 'false';
    closeScribeMenus();
    menu.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
    trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    scribeMenuOpen = willOpen;
  }

  function createMenuButton(box, mode, title) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn typecho-scribe-menu-button';
    button.innerHTML = (MODE_ICONS[mode] || '') + '<span>' + title + '</span>';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      closeScribeMenus();
      runScribe(box, button, mode);
    });
    scribeButtons.push(button);
    return button;
  }

  function createWritingSettings(box) {
    var settings = document.createElement('div');
    settings.className = 'typecho-scribe-writing-settings';
    settings.innerHTML = [
      '<div class="typecho-scribe-setting">',
      '<label for="typecho-scribe-user-prompt">User Prompt</label>',
      '<textarea id="typecho-scribe-user-prompt" data-scribe-setting="userPrompt" rows="3"></textarea>',
      '</div>',
      '<div class="typecho-scribe-setting">',
      '<label for="typecho-scribe-output-language">输出语言</label>',
      '<select id="typecho-scribe-output-language" data-scribe-setting="outputLanguage">',
      '<option value="auto">自动判断</option>',
      '<option value="zh-CN">简体中文</option>',
      '<option value="zh-TW">繁体中文</option>',
      '<option value="en">English</option>',
      '<option value="ja">日本語</option>',
      '<option value="ko">한국어</option>',
      '</select>',
      '</div>',
      '<details class="typecho-scribe-advanced">',
      '<summary>高级设置</summary>',
      '<div class="typecho-scribe-advanced-fields">',
      '<div class="typecho-scribe-setting">',
      '<label for="typecho-scribe-style-post-count">参考历史文章</label>',
      '<select id="typecho-scribe-style-post-count" data-scribe-setting="stylePostCount">',
      '<option value="0">不参考</option>',
      '<option value="5">5</option>',
      '<option value="10">10</option>',
      '</select>',
      '</div>',
      '<div class="typecho-scribe-setting">',
      '<label for="typecho-scribe-target-audience">目标读者</label>',
      '<input type="text" id="typecho-scribe-target-audience" data-scribe-setting="targetAudience">',
      '</div>',
      '<div class="typecho-scribe-setting">',
      '<label for="typecho-scribe-length-preset">篇幅策略</label>',
      '<select id="typecho-scribe-length-preset" data-scribe-setting="lengthPreset">',
      '<option value="concise">偏短</option>',
      '<option value="balanced">标准</option>',
      '<option value="detailed">深入</option>',
      '</select>',
      '</div>',
      '<div class="typecho-scribe-setting">',
      '<label for="typecho-scribe-fact-policy">事实策略</label>',
      '<select id="typecho-scribe-fact-policy" data-scribe-setting="factPolicy">',
      '<option value="conservative">实事求是</option>',
      '<option value="assumptive">头脑风暴</option>',
      '</select>',
      '</div>',
      '<div class="typecho-scribe-setting typecho-scribe-setting-wide">',
      '<label class="typecho-scribe-checkbox">',
      '<input type="checkbox" data-scribe-setting="includeBodyAssets">',
      '<span>发送正文图片和附件</span>',
      '</label>',
      '</div>',
      '</div>',
      '</details>'
    ].join('');

    function persist(event) {
      if (event.target && event.target.hasAttribute('data-scribe-setting')) {
        saveWritingSettings(collectWritingSettings(settings));
      }
    }
    settings.addEventListener('input', persist);
    settings.addEventListener('change', persist);
    applyWritingSettings(settings, loadWritingSettings());
    return settings;
  }

  function createScribeMenu(box) {
    var menu = document.createElement('div');
    menu.className = 'typecho-scribe-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-hidden', 'true');
    menu.addEventListener('click', function(event) {
      event.stopPropagation();
    });
    var actions = document.createElement('div');
    actions.className = 'typecho-scribe-menu-actions';
    Object.keys(MODE_LABELS).forEach(function(mode) {
      actions.appendChild(createMenuButton(box, mode, MODE_LABELS[mode]));
    });
    menu.appendChild(createWritingSettings(box));
    menu.appendChild(actions);
    return menu;
  }

  function createToolbarButton(box) {
    var item = document.createElement('li');
    item.id = 'wmd-scribe-button';
    item.className = 'wmd-button typecho-scribe-toolbar-button typecho-scribe-menu-trigger';
    item.title = '写作';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', '写作');
    item.setAttribute('aria-haspopup', 'menu');
    item.setAttribute('aria-expanded', 'false');
    item.innerHTML = SCRIBE_ICON;
    item.appendChild(createScribeMenu(box));
    item.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      toggleScribeMenu(item);
    });
    item.addEventListener('keydown', function(event) {
      // Key events from form controls inside the menu (e.g. the userPrompt
      // textarea) bubble up to this trigger; let Enter insert newlines and
      // Space type normally instead of toggling the menu.
      if (event.target && event.target.closest && event.target.closest('.typecho-scribe-menu')) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleScribeMenu(item);
      } else if (event.key === 'Escape') {
        closeScribeMenus();
      }
    });
    scribeButtons.push(item);
    return item;
  }

  function createFallbackButton(box) {
    var actions = box.querySelector('.typecho-scribe-fallback-actions');
    if (!actions || actions.querySelector('.typecho-scribe-fallback-btn')) return;
    var wrapper = document.createElement('span');
    wrapper.className = 'typecho-scribe-fallback-menu typecho-scribe-menu-trigger';
    wrapper.style.position = 'relative';
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-xs typecho-scribe-fallback-btn';
    button.innerHTML = SCRIBE_ICON;
    button.title = '写作';
    button.setAttribute('aria-label', '写作');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    wrapper.appendChild(button);
    wrapper.appendChild(createScribeMenu(box));
    button.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      toggleScribeMenu(wrapper);
    });
    actions.appendChild(wrapper);
    scribeButtons.push(button);
    box.hidden = false;
  }

  function mountButton(box) {
    if (document.getElementById('wmd-scribe-button')) return true;
    var row = document.getElementById('wmd-button-row');
    if (!row) return false;

    var spacer = document.createElement('li');
    spacer.className = 'wmd-spacer typecho-scribe-spacer';
    row.appendChild(spacer);
    row.appendChild(createToolbarButton(box));
    box.hidden = false;
    box.classList.add('typecho-scribe-mounted');
    return true;
  }

  function wireModalEvents() {
    var modal = document.querySelector('.typecho-scribe-modal');
    if (!modal || modal.getAttribute('data-wired') === '1') return;
    modal.setAttribute('data-wired', '1');

    function closeModal() {
      closePreviewModal(true);
    }

    modal.querySelectorAll('.typecho-scribe-modal-tab').forEach(function(button) {
      button.addEventListener('click', function() {
        setModalTab(button.getAttribute('data-scribe-tab') || 'write');
      });
    });
    modal.querySelector('.typecho-scribe-modal-write').addEventListener('input', function() {
      previewState.userEdited = true;
      previewState.currentText = this.value;
      renderModalViews();
      updateModalControls();
    });
    modal.querySelector('.typecho-scribe-modal-close').addEventListener('click', closeModal);
    modal.querySelector('.typecho-scribe-modal-cancel').addEventListener('click', closeModal);
    modal.querySelector('.typecho-scribe-modal-confirm').addEventListener('click', confirmInsert);
    modal.querySelector('.typecho-scribe-modal-followup-input').addEventListener('keydown', function(event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendFollowUp();
      }
    });
    modal.addEventListener('click', function(event) {
      if (event.target === modal) closePreviewModal(true);
    });
  }

  function initScribe() {
    var box = document.querySelector('.typecho-scribe');
    if (!box) return;
    var attempts = 0;
    var timer = window.setInterval(function() {
      attempts += 1;
      if (mountButton(box)) {
        window.clearInterval(timer);
      } else if (attempts >= 50) {
        window.clearInterval(timer);
        createFallbackButton(box);
      }
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScribe);
  } else {
    initScribe();
  }
  document.addEventListener('click', function(event) {
    if (event.target && event.target.closest && event.target.closest('.typecho-scribe-menu')) return;
    closeScribeMenus();
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape' && previewState.open) {
      closePreviewModal(true);
    }
  });
  wireModalEvents();
})();
</script>`;
}

export default function init({ addHook, pluginId }: PluginInitContext): void {
  addHook('admin:writePost:bottom', pluginId, (html: string) => html + POST_EDITOR_HTML);
  addHook('admin:writePage:bottom', pluginId, (html: string) => html + PAGE_EDITOR_HTML);

  addHook(
    'plugin:config:beforeSave',
    pluginId,
    async (result: ConfigValidationResult, extra?: { pluginId?: string; settings?: Record<string, unknown> }) => {
      if (extra?.pluginId !== pluginId) return result;

      try {
        const settings = await validateConfig(extra.settings || {});
        return { success: true, settings };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'LLM 配置校验失败',
        };
      }
    },
  );

  addHook(
    `plugin:${pluginId}:action:auth`,
    pluginId,
    (defaultRole: string, extra?: { action?: string }) => {
      // AI writing helpers write into the current editor session, so
      // contributor-level authors need to reach them. Restricting to
      // administrator would lock non-admin authors out of the feature.
      if (['generate', 'polish', 'correct', 'continue'].includes(extra?.action || '')) return 'contributor';
      return defaultRole;
    },
  );

  addHook(
    `plugin:${pluginId}:action`,
    pluginId,
    async (
      result: PluginActionResult,
      extra?: { action?: string; payload?: WriterPayload; options?: Record<string, unknown>; db?: Database },
    ) => {
      const action = extra?.action || '';
      if (!['generate', 'polish', 'correct', 'continue'].includes(action)) return result;

      try {
        const payload = extra?.payload || {};
        if (action === 'continue' && !String(payload.followUpPrompt || '').trim()) {
          throw new Error('缺少调整要求');
        }
        const config = applyWritingOptions(getConfig(extra?.options), extra?.payload?.writingOptions);
        const siteUrl = typeof extra?.options?.siteUrl === 'string' ? extra.options.siteUrl : undefined;
        const [styleSamples, assets] = await Promise.all([
          loadStyleSamples(extra?.db, Number.isFinite(Number(config.stylePostCount)) ? Number(config.stylePostCount) : 0),
          loadContentAssets(extra?.db, config, payload),
        ]);
        const response = await callLLMStream(config, action as WriterMode, payload, styleSamples, assets, siteUrl);
        return {
          handled: true,
          success: true,
          response,
        };
      } catch (error) {
        return {
          handled: true,
          success: false,
          error: error instanceof Error ? error.message : 'AI 写作失败',
        };
      }
    },
  );
}

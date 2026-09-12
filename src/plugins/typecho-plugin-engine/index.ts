import {
  fetchWithTimeout,
  hasPermission,
  parseAttachmentMeta,
  parsePluginOption,
  registerPluginAdminPath,
  setOption,
  stripTypechoMarkers,
} from 'typecho/plugin-sdk';
import type { AttachmentMeta, PluginInitContext, PluginRouteResult } from 'typecho/plugin-sdk';
import type { Database } from 'typecho/db';
import { schema } from 'typecho/db';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { getAuthCookies, validateAuthToken, requireAdminCSRF } from '@/lib/auth';
import { isSameOriginRequest } from '@/lib/admin-auth';
import {
  PLUGIN_ID as ENGINE_PLUGIN_ID,
  loadSettings,
  validateSettings,
  toFormValues,
  maskSecretFormValues,
  restoreSecretFormValues,
  isAutoSummaryEnabled,
} from './config';
import {
  upsertSummary,
  listPublishedForSummary,
} from './summary';

export { readSummary, ENGINE_SUMMARY_FIELD } from './summary';
export { upsertSummary };
import {
  ADMIN_PAGE_SLUG,
  CONFIG_API_ROUTE,
  adminPageHtml,
  isEngineAdminSlug,
} from './admin-page';

import { isInternalSearchRequest, searchClientHtml, searchDisabledResponse } from './search';

// ===== 比对页签 diff 高亮算法（浏览器端执行）=====
// 浏览器端内联脚本无法 import 模块，以下纯函数经 toString() 序列化后拼入模板字符串注入页面；
// 单元测试直接 import 这些函数断言行为，与线上执行代码同源。
// 约定：函数体不使用模板字面量、不引用模块级常量（阈值等魔法数字直接内联），
// 保证序列化后自包含可执行；转译器可能重写字符串引号风格，测试断言按值而非精确源码文本。
// 比对视图为纯 markdown 源码对比（无 HTML 渲染层）：占位符删除词 \u0001…\u0002、新增词 \u0003…\u0004，
// 标记文本经 HTML 转义后由 engineRestoreMarks 还原为 span——只产生文本节点内的高亮，任何语法都不会被破坏；
// 渲染效果由独立的「预览」页签负责。
export const engineDiffAlgo = {
  engineTokenize,
  engineAppendLcs,
  engineLcsOps,
  engineWrapTokens,
  engineRestoreMarks,
  engineFinalizeDiff,
  engineDiffMarkup,
};

export const ENGINE_DIFF_ALGO_JS = Object.values(engineDiffAlgo)
  .map((fn) => fn.toString())
  .join('\n');

function engineTokenize(text: string): string[] {
  const re = /[\u4e00-\u9fffA-Za-z0-9_]+|\n|[^\u4e00-\u9fffA-Za-z0-9_\n]/g;
  return text.match(re) || [];
}

function engineAppendLcs(a: string[], b: string[], ops: DiffOp[]): void {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return;
  if (n === 0) {
    for (let j = 0; j < m; j++) ops.push({ t: 'i', s: b[j] });
    return;
  }
  if (m === 0) {
    for (let i = 0; i < n; i++) ops.push({ t: 'd', s: a[i] });
    return;
  }
  // 超大差异区放弃对齐、整块标记，避免 O(n*m) DP 拖垮页面
  if (n * m > 400000) {
    for (let i = 0; i < n; i++) ops.push({ t: 'd', s: a[i] });
    for (let j = 0; j < m; j++) ops.push({ t: 'i', s: b[j] });
    return;
  }
  const dp: number[][] = [];
  for (let r = 0; r <= n; r++) {
    dp.push(new Array(m + 1));
    for (let c = 0; c <= m; c++) dp[r][c] = 0;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
    }
  }
  const rev: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      rev.push({ t: 'e', s: a[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      rev.push({ t: 'd', s: a[i - 1] });
      i--;
    } else {
      rev.push({ t: 'i', s: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    rev.push({ t: 'd', s: a[i - 1] });
    i--;
  }
  while (j > 0) {
    rev.push({ t: 'i', s: b[j - 1] });
    j--;
  }
  for (i = rev.length - 1; i >= 0; i--) ops.push(rev[i]);
}

// 通用 LCS diff：先裁剪相同前后缀缩小 DP 规模
function engineLcsOps(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ t: 'e', s: a[i] });
  engineAppendLcs(a.slice(start, endA), b.slice(start, endB), ops);
  for (let i = endA; i < a.length; i++) ops.push({ t: 'e', s: a[i] });
  return ops;
}

// 按 ops 重建单侧文本：del 侧取 e/d token、ins 侧取 e/i token，另一侧 token 跳过；
// 指定类型 token 用控制字符占位符包裹；连续同型 token 合并成一次包裹（\n 断开合并且不包裹），
// 避免 markdown 语法/URL 的符号 token 被逐字符高亮成碎片
function engineWrapTokens(ops: DiffOp[], kind: 'del' | 'ins'): string {
  let out = '';
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (kind === 'del') {
      if (op.t === 'i') {
        i++;
        continue;
      }
      if (op.t === 'd' && op.s !== '\n') {
        let buf = '';
        while (i < ops.length && ops[i].t === 'd' && ops[i].s !== '\n') {
          buf += ops[i].s;
          i++;
        }
        out += '\u0001' + buf + '\u0002';
        continue;
      }
      out += op.s;
      i++;
    } else {
      if (op.t === 'd') {
        i++;
        continue;
      }
      if (op.t === 'i' && op.s !== '\n') {
        let buf = '';
        while (i < ops.length && ops[i].t === 'i' && ops[i].s !== '\n') {
          buf += ops[i].s;
          i++;
        }
        out += '\u0003' + buf + '\u0004';
        continue;
      }
      out += op.s;
      i++;
    }
  }
  return out;
}

// 把占位符还原为高亮 span（纯文本对比视图：标记文本经 HTML 转义后还原，只产生文本节点内的 span，安全）
function engineRestoreMarks(html: string): string {
  return html
    .replace(/\u0001([\s\S]*?)\u0002/g, (_match, text: string) => {
      return '<span class="typecho-engine-diff-del">' + text + '</span>';
    })
    .replace(/\u0003([\s\S]*?)\u0004/g, (_match, text: string) => {
      return '<span class="typecho-engine-diff-ins">' + text + '</span>';
    });
}

function engineFinalizeDiff(pending: { oldLines: string[]; newLines: string[] }): EngineDiffBlock {
  let oldText = pending.oldLines.join('\n');
  let newText = pending.newLines.join('\n');
  // words === null 表示两侧相同块；'whole' 表示超限降级、整块标记（不进入词级对齐）
  let words: DiffOp[] | 'whole' | null = null;
  if (oldText.length + newText.length <= 20000) {
    const oldTokens = engineTokenize(oldText);
    const newTokens = engineTokenize(newText);
    if (oldTokens.length * newTokens.length <= 400000) {
      words = engineLcsOps(oldTokens, newTokens);
      oldText = engineWrapTokens(words, 'del');
      newText = engineWrapTokens(words, 'ins');
      return { old: oldText, new: newText, words };
    }
  }
  words = 'whole';
  oldText = oldText ? '\u0001' + oldText + '\u0002' : '';
  newText = newText ? '\u0003' + newText + '\u0004' : '';
  return { old: oldText, new: newText, words };
}

// 行级 diff + 相邻差异块合并（间隔 ≤ 2 行相同行并入作上下文，避免段落被割裂渲染）
// 返回 { hasDiff, blocks }；blocks 元素 { old, new, words }，words === null 表示两侧相同块
function engineDiffMarkup(
  oldText: string,
  newText: string,
): { hasDiff: boolean; blocks: EngineDiffBlock[] } {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const ops = engineLcsOps(oldLines, newLines);
  const blocks: EngineDiffBlock[] = [];
  let pending: { oldLines: string[]; newLines: string[] } | null = null;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === 'e') {
      const eLines: string[] = [];
      while (i < ops.length && ops[i].t === 'e') {
        eLines.push(ops[i].s);
        i++;
      }
      const hasLater = i < ops.length;
      if (pending && hasLater && eLines.length <= 2) {
        for (let k = 0; k < eLines.length; k++) {
          pending.oldLines.push(eLines[k]);
          pending.newLines.push(eLines[k]);
        }
      } else {
        if (pending) {
          blocks.push(engineFinalizeDiff(pending));
          pending = null;
        }
        blocks.push({ old: eLines.join('\n'), new: eLines.join('\n'), words: null });
      }
    } else {
      if (!pending) pending = { oldLines: [], newLines: [] };
      if (ops[i].t === 'd') pending.oldLines.push(ops[i].s);
      else pending.newLines.push(ops[i].s);
      i++;
    }
  }
  if (pending) blocks.push(engineFinalizeDiff(pending));
  let hasDiff = false;
  for (let b = 0; b < blocks.length; b++) {
    if (blocks[b].words !== null) {
      hasDiff = true;
      break;
    }
  }
  return { hasDiff, blocks };
}

// diff 算法操作序列：t 为 e(equal)/d(del)/i(ins)，s 为 token（行或词）
type DiffOp = { t: 'e' | 'd' | 'i'; s: string };
// 渲染块：words === null 表示两侧相同块（直接渲染）；
// words === 'whole' 表示超限降级块（old/new 已整块带占位符标记）；否则为词级差异块
type EngineDiffBlock = { old: string; new: string; words: DiffOp[] | 'whole' | null };

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

interface EngineConfig {
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
  settings?: EngineConfig;
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

const PLUGIN_ID = ENGINE_PLUGIN_ID;

const DEFAULTS: EngineConfig = {
  endpoint: 'https://open.bigmodel.cn/api/paas/v4/',
  apiKey: '',
  model: 'glm-4.7-flash',
  temperature: '0.7',
  maxTokens: '128000',
  stylePostCount: '5',
  outputLanguage: 'auto',
  targetAudience: '',
  lengthPreset: 'balanced',
  factPolicy: 'conservative',
  userPrompt: '',
  includeBodyAssets: '0',
};

// Keep the LLM request timeout below the generic plugin-action timeout so a
// slow provider surfaces Engine's specific error instead of a generic 500.
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

function normalizeConfig(settings?: Record<string, unknown>): EngineConfig {
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

function applyWritingOptions(config: EngineConfig, options?: WriterWritingOptions): EngineConfig {
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

function getConfig(options?: Record<string, unknown>): EngineConfig {
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

function buildConfiguredUserPrompt(config: EngineConfig): string {
  if (!config.userPrompt) {
    return '未配置额外写作要求。';
  }

  return [
    '以下是站点管理员配置的额外写作要求，请在不违背系统约束和事实准确性的前提下遵循：',
    config.userPrompt,
  ].join('\n');
}

function buildWritingProfile(config: EngineConfig): string {
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

function shouldIncludeBodyAssets(config: EngineConfig): boolean {
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
  config: EngineConfig,
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

function validationHeaders(config: EngineConfig): HeadersInit {
  return {
    Authorization: `Bearer ${config.apiKey}`,
  };
}

async function validateConfig(settings?: Record<string, unknown>): Promise<EngineConfig> {
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
  config: EngineConfig,
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
  config: EngineConfig,
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
  config: EngineConfig,
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

const SUMMARY_SYSTEM_PROMPT = [
  '你是一位内容摘要助手。',
  '根据标题与正文生成帮助读者快速理解内容的简明中文摘要。',
  '摘要应覆盖主题与关键信息点，不要编造正文没有的事实。',
  '只输出摘要正文本身，不要标题、前后缀、列表符号或引号包裹。',
  '长度控制在 80～120 字。',
].join('\n');

async function callLLMSummary(config: EngineConfig, title: string, body: string): Promise<string> {
  if (!config.endpoint || !config.apiKey || !config.model) {
    throw new Error('请先完整配置接口地址、API Key 和模型名称');
  }

  const userPrompt = [
    `标题：${title || '（无标题）'}`,
    '正文：',
    truncateText(stripTypechoMarkers(body || ''), 12000),
  ].join('\n');

  const response = await fetchWithTimeout(
    buildChatCompletionsUrl(config.endpoint),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...validationHeaders(config),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: Math.min(Number(config.temperature) || 0.7, 0.7),
        max_tokens: Math.min(Number(config.maxTokens) || 1024, 1024),
        stream: false,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
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

async function summarizeOneCid(db: Database, options: Record<string, unknown>, cid: number): Promise<string> {
  const row = await db.query.contents.findFirst({
    where: eq(schema.contents.cid, cid),
    columns: { cid: true, title: true, text: true, type: true, status: true },
  });
  if (!row) throw new Error('内容不存在');
  if (row.status !== 'publish' || (row.type !== 'post' && row.type !== 'page')) {
    throw new Error('仅支持已发布的文章或页面');
  }

  const config = getConfig(options);
  const summary = await callLLMSummary(config, row.title || '', row.text || '');
  if (!summary) throw new Error('摘要为空');
  await upsertSummary(db, cid, summary);
  return summary;
}

interface ContentFinishData {
  cid?: number;
  title?: string | null;
  text?: string | null;
  type?: string | null;
  status?: string | null;
}

interface ContentFinishExtra {
  db?: Database;
  options?: Record<string, unknown>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

async function scheduleSummaryMaterialize(content: ContentFinishData, extra?: ContentFinishExtra): Promise<void> {
  const cid = Number(content.cid);
  if (!Number.isInteger(cid) || cid <= 0 || !extra?.db || !extra.options) return;
  if (content.status !== 'publish' || (content.type !== 'post' && content.type !== 'page')) return;
  // Disabled means no summary work at all, including database reads/writes.
  if (!isAutoSummaryEnabled(loadSettings(extra.options))) return;

  const db = extra.db;
  const options = extra.options;
  const run = async () => {
    try {
      const summary = await callLLMSummary(getConfig(options), content.title || '', content.text || '');
      if (summary) await upsertSummary(db, cid, summary);
    } catch (error) {
      // Publishing succeeds even if AI fails. Never replace an existing summary
      // with a truncated fallback (or clear it on failure).
      console.error(`[${PLUGIN_ID}] 智能摘要生成失败，保留已有摘要:`, error);
    }
  };

  if (extra.waitUntil) {
    extra.waitUntil(run());
  } else {
    // Tests/adapters without an execution context must not drop the write.
    await run();
  }
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
  config: EngineConfig,
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
#wmd-engine-button .typecho-engine-toolbar-icon,
.typecho-engine-fallback-btn .typecho-engine-toolbar-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 11px;
  font-weight: 700;
  color: #666;
}
#wmd-engine-button {
  position: relative;
}
#wmd-engine-button[aria-disabled="true"] {
  opacity: .5;
  cursor: default;
}
#wmd-engine-button .typecho-engine-menu span {
  display: unset;
  width: unset;
  height: unset;
}

.typecho-engine-menu {
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
.typecho-engine-menu[aria-hidden="false"] {
  display: flex;
}
.typecho-engine-menu-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.typecho-engine-menu-button svg {
  flex-shrink: 0;
}
.typecho-engine-menu-button:hover,
.typecho-engine-menu-button:focus {
  background: #f0f0f0;
  color: #222;
  outline: none;
}
.typecho-engine-menu-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  border-top: 1px dashed #d9d9d9;
  padding-top: 8px;
}
.typecho-engine-menu-button[aria-disabled="true"] {
  opacity: .5;
  cursor: default;
}

.typecho-engine-writing-settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.typecho-engine-setting {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.typecho-engine-setting > label {
  font-size: 12px;
  color: #555;
}
.typecho-engine-setting textarea,
.typecho-engine-setting input[type="text"],
.typecho-engine-setting select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  border: 1px solid #d9d9d9;
  border-radius: 2px;
  background: #fff;
  color: #333;
  font: 13px/1.5 inherit;
}
.typecho-engine-setting textarea {
  min-height: 64px;
  padding: 5px 7px;
  resize: vertical;
}
.typecho-engine-setting input[type="text"] {
  height: 28px;
  padding: 4px 7px;
}
.typecho-engine-setting select {
  height: 28px;
  padding: 2px 6px;
}
.typecho-engine-setting textarea:focus,
.typecho-engine-setting input[type="text"]:focus,
.typecho-engine-setting select:focus {
  border-color: #467b96;
  outline: none;
}
.typecho-engine-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #333;
  cursor: pointer;
}
.typecho-engine-advanced {
  border-top: 1px dashed #d9d9d9;
  padding-top: 8px;
}
.typecho-engine-advanced summary {
  cursor: pointer;
  font-size: 12px;
  color: #666;
  user-select: none;
}
.typecho-engine-advanced[open] summary {
  color: #222;
}
.typecho-engine-advanced-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding-top: 8px;
}
.typecho-engine-advanced-fields .typecho-engine-setting-wide {
  grid-column: 1 / -1;
}

.typecho-engine-modal {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 1000;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0, 0, 0, .45);
}
.typecho-engine-modal[aria-hidden="false"] {
  display: flex;
}
.typecho-engine-modal-dialog {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(1280px, 100%);
  max-height: calc(100vh - 40px);
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, .25);
}
.typecho-engine-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid #e5e5e5;
}
.typecho-engine-modal-title {
  font-size: 15px;
  font-weight: 600;
  color: #222;
}
.typecho-engine-modal-tabs {
  display: flex;
  gap: 2px;
  margin-left: auto;
}
.typecho-engine-modal-tab {
  border: 0;
  background: none;
  padding: 4px 10px;
  font-size: 13px;
  line-height: 1;
  color: #666;
  cursor: pointer;
  border-radius: 2px;
}
.typecho-engine-modal-tab:hover,
.typecho-engine-modal-tab:focus {
  background: #f0f0f0;
  color: #222;
  outline: none;
}
.typecho-engine-modal-tab.active {
  background: #467b96;
  color: #fff;
}
.typecho-engine-modal-close {
  border: 0;
  background: none;
  padding: 2px 8px;
  font-size: 20px;
  line-height: 1;
  color: #888;
  cursor: pointer;
}
.typecho-engine-modal-close:hover {
  color: #333;
}
.typecho-engine-modal-body {
  position: relative;
  flex: 0 0 auto;
  height: 42vh;
  min-height: 200px;
  margin: 12px 16px 0;
}
.typecho-engine-modal-write {
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
.typecho-engine-modal-write:focus {
  border-color: #467b96;
  outline: none;
}
.typecho-engine-modal-preview {
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
.typecho-engine-modal-compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  height: 100%;
}
.typecho-engine-modal-compare-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid #e5e5e5;
  border-radius: 3px;
  background: #fff;
  overflow: hidden;
}
.typecho-engine-modal-compare-label {
  padding: 6px 10px;
  font-size: 12px;
  color: #666;
  border-bottom: 1px solid #e5e5e5;
  background: #fafafa;
  user-select: none;
}
.typecho-engine-modal-compare-content {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
  word-wrap: break-word;
  overflow-wrap: break-word;
  font-size: 13px;
  line-height: 1.7;
  color: #333;
}
.typecho-engine-modal-compare-content.typecho-engine-modal-compare-empty {
  color: #999;
}
.typecho-engine-diff-del {
  padding: 0 1px;
  border-radius: 2px;
  background: #ffe3e3;
  color: #b3382c;
  text-decoration: line-through;
}
.typecho-engine-diff-ins {
  padding: 0 1px;
  border-radius: 2px;
  background: #ddf3dd;
  color: #257a25;
}
.typecho-engine-modal-compare-md {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font: 13px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  color: #333;
}
.typecho-engine-diff-note {
  padding: 4px 8px;
  margin-bottom: 8px;
  font-size: 12px;
  color: #999;
  background: #fafafa;
  border: 1px dashed #ddd;
  border-radius: 2px;
}
.typecho-engine-tab-hidden {
  display: none !important;
}
.typecho-engine-modal-followup {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 16px;
}
.typecho-engine-modal-followup-input {
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
.typecho-engine-modal-followup-input:focus {
  border-color: #467b96;
  outline: none;
}
.typecho-engine-modal-followup-input::placeholder {
  color: #999;
}
.typecho-engine-modal-followup-hint {
  font-size: 12px;
  color: #999;
  user-select: none;
}
.typecho-engine-modal-status {
  flex: 1;
  font-size: 12px;
  color: #666;
}
.typecho-engine-modal-status-error {
  color: #c33;
}
.typecho-engine-modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #e5e5e5;
}
.typecho-engine-modal-confirm[disabled] {
  opacity: .5;
  cursor: default;
}

.typecho-engine-fallback-btn svg {
  display: block;
  width: 16px;
  height: 16px;
}
</style>
<div class="typecho-engine" data-content-type="${contentType}" hidden>
  <span class="typecho-engine-fallback-actions"></span>
</div>
<div class="typecho-engine-modal" aria-hidden="true">
  <div class="typecho-engine-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="typecho-engine-modal-title">
    <div class="typecho-engine-modal-header">
      <span class="typecho-engine-modal-title" id="typecho-engine-modal-title">AI 预览</span>
      <div class="typecho-engine-modal-tabs" role="tablist" aria-label="预览模式">
        <button type="button" class="typecho-engine-modal-tab active" data-engine-tab="write" role="tab" aria-selected="true">撰写</button>
        <button type="button" class="typecho-engine-modal-tab" data-engine-tab="preview" role="tab" aria-selected="false">预览</button>
        <button type="button" class="typecho-engine-modal-tab" data-engine-tab="compare" role="tab" aria-selected="false">比对</button>
      </div>
      <button type="button" class="typecho-engine-modal-close" aria-label="关闭预览">&times;</button>
    </div>
    <div class="typecho-engine-modal-body">
      <textarea class="typecho-engine-modal-write mono" spellcheck="false" aria-label="AI 生成内容"></textarea>
      <div class="typecho-engine-modal-preview wmd-preview typecho-engine-tab-hidden" role="status" aria-live="polite"></div>
      <div class="typecho-engine-modal-compare typecho-engine-tab-hidden">
        <div class="typecho-engine-modal-compare-pane">
          <div class="typecho-engine-modal-compare-label">原文</div>
          <div class="typecho-engine-modal-compare-content typecho-engine-modal-compare-original"></div>
        </div>
        <div class="typecho-engine-modal-compare-pane">
          <div class="typecho-engine-modal-compare-label">AI 生成</div>
          <div class="typecho-engine-modal-compare-content typecho-engine-modal-compare-generated"></div>
        </div>
      </div>
    </div>
    <div class="typecho-engine-modal-followup">
      <textarea class="typecho-engine-modal-followup-input" placeholder="输入调整要求，发送后 AI 将结合原文与当前结果继续调整，结果实时显示在上方"></textarea>
      <span class="typecho-engine-modal-followup-hint">Enter 发送 · Shift+Enter 换行</span>
    </div>
    <div class="typecho-engine-modal-footer">
      <div class="typecho-engine-modal-status" role="status" aria-live="polite"></div>
      <button type="button" class="btn typecho-engine-modal-cancel">取消</button>
      <button type="button" class="btn primary typecho-engine-modal-confirm" disabled>确定</button>
    </div>
  </div>
</div>
<script is:inline>
(function() {
  if (window.__typechoEngineReady) return;
  window.__typechoEngineReady = true;

  function clearAdminNotice() {
    var notice = document.querySelector('.typecho-engine-notice');
    if (notice && notice.parentNode) {
      notice.parentNode.removeChild(notice);
    }
  }

  function showAdminNotice(message, type) {
    clearAdminNotice();

    var notice = document.createElement('div');
    var isError = type === 'error';
    notice.className = 'typecho-engine-notice typecho-option-tabs notice typecho-dismissible ' + (isError ? 'notice-error' : 'notice-success');
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

  var ENGINE_ICON = '<span class="typecho-engine-toolbar-icon" aria-hidden="true">AI</span>';
  var MODE_ICONS = {
    generate: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    polish: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    correct: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 10 2 2 4-4"/><rect width="20" height="20" x="2" y="2" rx="4" opacity=".25"/><path d="M20.5 2.5 15 20 9 17l-5.5 3L6 14Z"/></svg>'
  };
  var engineButtons = [];
  var MODE_LABELS = { generate: '生成', polish: '润色', correct: '纠错' };
  var WRITING_STORAGE_KEY = 'typecho-engine-writing-settings';
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
      var field = container.querySelector('[data-engine-setting="' + name + '"]');
      return field ? field.value : fallback;
    }

    var checkbox = container.querySelector('[data-engine-setting="includeBodyAssets"]');
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
    root.querySelectorAll('[data-engine-setting]').forEach(function(field) {
      var name = field.getAttribute('data-engine-setting');
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
    if (!source) return '<p class="typecho-engine-modal-compare-empty">（无内容）</p>';
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

${ENGINE_DIFF_ALGO_JS}

  function setModalTab(tab) {
    previewState.tab = tab;
    var modal = document.querySelector('.typecho-engine-modal');
    if (!modal) return;
    modal.querySelectorAll('.typecho-engine-modal-tab').forEach(function(button) {
      var isActive = button.getAttribute('data-engine-tab') === tab;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    var writeEl = modal.querySelector('.typecho-engine-modal-write');
    var previewEl = modal.querySelector('.typecho-engine-modal-preview');
    var compareEl = modal.querySelector('.typecho-engine-modal-compare');
    writeEl.classList.toggle('typecho-engine-tab-hidden', tab !== 'write');
    previewEl.classList.toggle('typecho-engine-tab-hidden', tab !== 'preview');
    compareEl.classList.toggle('typecho-engine-tab-hidden', tab !== 'compare');
    renderModalViews();
  }

  function renderModalViews() {
    var modal = document.querySelector('.typecho-engine-modal');
    if (!modal || !previewState.open) return;
    var writeEl = modal.querySelector('.typecho-engine-modal-write');
    var previewEl = modal.querySelector('.typecho-engine-modal-preview');
    var originalEl = modal.querySelector('.typecho-engine-modal-compare-original');
    var generatedEl = modal.querySelector('.typecho-engine-modal-compare-generated');
    // 用户已开始手动编辑时，以 textarea 内容为准，流式内容不再覆盖。
    var text = previewState.userEdited ? writeEl.value : previewState.currentText;
    if (!previewState.userEdited) {
      writeEl.value = text;
    }
    previewEl.innerHTML = renderMarkdown(text);
    // 比对视图只在页签激活时计算（流式期间每帧重算成本低，关闭后不更新）
    if (previewState.tab === 'compare') {
      renderComparePanes(originalEl, generatedEl, previewState.oldText, text);
    }
  }

  // 比对页签：纯 markdown 源码对比。行级/词级 diff 标记文本经 HTML 转义后
  // 由 engineRestoreMarks 还原为高亮 span——只产生文本节点内的 span，
  // 任何 markdown 语法（引用式图片/链接、分割线、表格、代码块）都不会被破坏；
  // 渲染效果由「预览」页签查看
  function renderComparePanes(originalEl, generatedEl, oldText, newText) {
    var diff = engineDiffMarkup(oldText || '', newText || '');
    if (!diff.hasDiff) {
      var note = '<div class="typecho-engine-diff-note">内容无差异</div>';
      originalEl.innerHTML = note + '<pre class="typecho-engine-modal-compare-md">' + escapeHtmlText(oldText) + '</pre>';
      generatedEl.innerHTML = note + '<pre class="typecho-engine-modal-compare-md">' + escapeHtmlText(newText) + '</pre>';
      return;
    }
    var oldHtml = '';
    var newHtml = '';
    for (var i = 0; i < diff.blocks.length; i++) {
      var block = diff.blocks[i];
      if (block.words === null) {
        oldHtml += escapeHtmlText(block.old);
        newHtml += escapeHtmlText(block.new);
      } else {
        oldHtml += engineRestoreMarks(escapeHtmlText(block.old));
        newHtml += engineRestoreMarks(escapeHtmlText(block.new));
      }
    }
    originalEl.innerHTML = '<pre class="typecho-engine-modal-compare-md">' + oldHtml + '</pre>';
    generatedEl.innerHTML = '<pre class="typecho-engine-modal-compare-md">' + newHtml + '</pre>';
    // 内容重渲染后（流式/编辑变化）按最近滚动源恢复同步，避免两侧比例漂移
    if (compareScrollSource === generatedEl) {
      syncCompareScroll(generatedEl, originalEl);
    } else if (compareScrollSource === originalEl) {
      syncCompareScroll(originalEl, generatedEl);
    }
  }

  // 比对双栏同步滚动：以最近一次滚动的栏为源，按滚动比例同步另一栏
  var compareScrollSource = null;
  var compareScrollSyncing = false;

  function syncCompareScroll(source, target) {
    var maxSource = source.scrollHeight - source.clientHeight;
    var maxTarget = target.scrollHeight - target.clientHeight;
    if (maxTarget <= 0) {
      if (target.scrollTop !== 0) target.scrollTop = 0;
      return;
    }
    var ratio = maxSource > 0 ? source.scrollTop / maxSource : 0;
    var next = ratio * maxTarget;
    // 阈值避免程序化赋值再次派发 scroll 事件造成的 1px 级回环抖动
    if (Math.abs(target.scrollTop - next) >= 2) target.scrollTop = next;
  }

  function onCompareScroll(source, target) {
    if (compareScrollSyncing) return;
    compareScrollSyncing = true;
    compareScrollSource = source;
    syncCompareScroll(source, target);
    compareScrollSyncing = false;
  }

  function scrollActiveViewToBottom() {
    var modal = document.querySelector('.typecho-engine-modal');
    if (!modal) return;
    var el = modal.querySelector('.typecho-engine-modal-write:not(.typecho-engine-tab-hidden)')
      || modal.querySelector('.typecho-engine-modal-preview:not(.typecho-engine-tab-hidden)')
      || modal.querySelector('.typecho-engine-modal-compare-generated');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function currentTaskLabel() {
    return previewState.followUpPrompt ? '调整' : modeLabel(previewState.mode);
  }

  function updateModalControls() {
    var confirmBtn = document.querySelector('.typecho-engine-modal-confirm');
    var writeEl = document.querySelector('.typecho-engine-modal-write');
    var hasText = previewState.userEdited
      ? !!writeEl.value.trim()
      : !!previewState.currentText;
    var canAct = !previewState.streaming && !previewState.error && hasText;
    confirmBtn.disabled = !canAct;
  }

  function setModalStreaming(streaming, label) {
    var statusEl = document.querySelector('.typecho-engine-modal-status');
    if (streaming) {
      statusEl.textContent = label || 'AI 正在生成...';
      statusEl.classList.remove('typecho-engine-modal-status-error');
      statusEl.classList.add('loading');
    } else {
      statusEl.classList.remove('loading');
    }
    updateModalControls();
  }

  function showModalStatus(message) {
    var statusEl = document.querySelector('.typecho-engine-modal-status');
    statusEl.textContent = message || '';
    statusEl.classList.remove('typecho-engine-modal-status-error');
    statusEl.classList.remove('loading');
    updateModalControls();
  }

  function showModalError(message) {
    var statusEl = document.querySelector('.typecho-engine-modal-status');
    statusEl.textContent = message || 'AI 写作失败';
    statusEl.classList.add('typecho-engine-modal-status-error');
    statusEl.classList.remove('loading');
    updateModalControls();
  }

  function openPreviewModal(mode) {
    var modal = document.querySelector('.typecho-engine-modal');
    modal.querySelector('.typecho-engine-modal-title').textContent = 'AI ' + modeLabel(mode) + '预览';
    modal.setAttribute('aria-hidden', 'false');
    previewState.open = true;
    previewState.userEdited = false;
    closeEngineMenus();
    setModalTab('write');
  }

  function closePreviewModal(abort) {
    if (!previewState.open) return;
    if (abort && previewState.controller) {
      previewState.controller.abort();
    }
    var modal = document.querySelector('.typecho-engine-modal');
    modal.setAttribute('aria-hidden', 'true');
    modal.querySelector('.typecho-engine-modal-write').value = '';
    modal.querySelector('.typecho-engine-modal-preview').innerHTML = '';
    modal.querySelector('.typecho-engine-modal-compare-original').innerHTML = '';
    modal.querySelector('.typecho-engine-modal-compare-generated').innerHTML = '';
    modal.querySelector('.typecho-engine-modal-followup-input').value = '';
    modal.querySelector('.typecho-engine-modal-status').textContent = '';
    modal.querySelector('.typecho-engine-modal-status').classList.remove('typecho-engine-modal-status-error');
    modal.querySelector('.typecho-engine-modal-status').classList.remove('loading');
    previewState.open = false;
    previewState.controller = null;
    previewState.userEdited = false;
    compareScrollSource = null;
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
    var writeEl = document.querySelector('.typecho-engine-modal-write');
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
      writingOptions: collectWritingSettings(previewState.box.querySelector('.typecho-engine-menu') || previewState.box)
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
    var writeEl = document.querySelector('.typecho-engine-modal-write');
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
    var input = document.querySelector('.typecho-engine-modal-followup-input');
    var prompt = input.value.trim();
    if (!prompt) return;
    previewState.followUpPrompt = prompt;
    input.value = '';
    startStream();
  }

  function confirmInsert() {
    if (!previewState.open || previewState.streaming || previewState.error) return;
    var writeEl = document.querySelector('.typecho-engine-modal-write');
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

  async function runEngine(box, button, requestedMode) {
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

  var engineMenuOpen = false;

  function closeEngineMenus() {
    if (!engineMenuOpen) return;
    engineMenuOpen = false;
    document.querySelectorAll('.typecho-engine-menu').forEach(function(menu) {
      menu.setAttribute('aria-hidden', 'true');
    });
    document.querySelectorAll('.typecho-engine-menu-trigger').forEach(function(trigger) {
      trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function toggleEngineMenu(trigger) {
    if (!trigger || trigger.getAttribute('aria-disabled') === 'true') return;
    var menu = trigger.querySelector('.typecho-engine-menu');
    if (!menu) return;
    var willOpen = menu.getAttribute('aria-hidden') !== 'false';
    closeEngineMenus();
    menu.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
    trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    engineMenuOpen = willOpen;
  }

  function createMenuButton(box, mode, title) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn typecho-engine-menu-button';
    button.innerHTML = (MODE_ICONS[mode] || '') + '<span>' + title + '</span>';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      closeEngineMenus();
      runEngine(box, button, mode);
    });
    engineButtons.push(button);
    return button;
  }

  function createWritingSettings(box) {
    var settings = document.createElement('div');
    settings.className = 'typecho-engine-writing-settings';
    settings.innerHTML = [
      '<div class="typecho-engine-setting">',
      '<label for="typecho-engine-user-prompt">User Prompt</label>',
      '<textarea id="typecho-engine-user-prompt" data-engine-setting="userPrompt" rows="3"></textarea>',
      '</div>',
      '<div class="typecho-engine-setting">',
      '<label for="typecho-engine-output-language">输出语言</label>',
      '<select id="typecho-engine-output-language" data-engine-setting="outputLanguage">',
      '<option value="auto">自动判断</option>',
      '<option value="zh-CN">简体中文</option>',
      '<option value="zh-TW">繁体中文</option>',
      '<option value="en">English</option>',
      '<option value="ja">日本語</option>',
      '<option value="ko">한국어</option>',
      '</select>',
      '</div>',
      '<details class="typecho-engine-advanced">',
      '<summary>高级设置</summary>',
      '<div class="typecho-engine-advanced-fields">',
      '<div class="typecho-engine-setting">',
      '<label for="typecho-engine-style-post-count">参考历史文章</label>',
      '<select id="typecho-engine-style-post-count" data-engine-setting="stylePostCount">',
      '<option value="0">不参考</option>',
      '<option value="5">5</option>',
      '<option value="10">10</option>',
      '</select>',
      '</div>',
      '<div class="typecho-engine-setting">',
      '<label for="typecho-engine-target-audience">目标读者</label>',
      '<input type="text" id="typecho-engine-target-audience" data-engine-setting="targetAudience">',
      '</div>',
      '<div class="typecho-engine-setting">',
      '<label for="typecho-engine-length-preset">篇幅策略</label>',
      '<select id="typecho-engine-length-preset" data-engine-setting="lengthPreset">',
      '<option value="concise">偏短</option>',
      '<option value="balanced">标准</option>',
      '<option value="detailed">深入</option>',
      '</select>',
      '</div>',
      '<div class="typecho-engine-setting">',
      '<label for="typecho-engine-fact-policy">事实策略</label>',
      '<select id="typecho-engine-fact-policy" data-engine-setting="factPolicy">',
      '<option value="conservative">实事求是</option>',
      '<option value="assumptive">头脑风暴</option>',
      '</select>',
      '</div>',
      '<div class="typecho-engine-setting typecho-engine-setting-wide">',
      '<label class="typecho-engine-checkbox">',
      '<input type="checkbox" data-engine-setting="includeBodyAssets">',
      '<span>发送正文图片和附件</span>',
      '</label>',
      '</div>',
      '</div>',
      '</details>'
    ].join('');

    function persist(event) {
      if (event.target && event.target.hasAttribute('data-engine-setting')) {
        saveWritingSettings(collectWritingSettings(settings));
      }
    }
    settings.addEventListener('input', persist);
    settings.addEventListener('change', persist);
    applyWritingSettings(settings, loadWritingSettings());
    return settings;
  }

  function createEngineMenu(box) {
    var menu = document.createElement('div');
    menu.className = 'typecho-engine-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-hidden', 'true');
    menu.addEventListener('click', function(event) {
      event.stopPropagation();
    });
    var actions = document.createElement('div');
    actions.className = 'typecho-engine-menu-actions';
    Object.keys(MODE_LABELS).forEach(function(mode) {
      actions.appendChild(createMenuButton(box, mode, MODE_LABELS[mode]));
    });
    menu.appendChild(createWritingSettings(box));
    menu.appendChild(actions);
    return menu;
  }

  function createToolbarButton(box) {
    var item = document.createElement('li');
    item.id = 'wmd-engine-button';
    item.className = 'wmd-button typecho-engine-toolbar-button typecho-engine-menu-trigger';
    item.title = '写作';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', '写作');
    item.setAttribute('aria-haspopup', 'menu');
    item.setAttribute('aria-expanded', 'false');
    item.innerHTML = ENGINE_ICON;
    item.appendChild(createEngineMenu(box));
    item.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      toggleEngineMenu(item);
    });
    item.addEventListener('keydown', function(event) {
      // Key events from form controls inside the menu (e.g. the userPrompt
      // textarea) bubble up to this trigger; let Enter insert newlines and
      // Space type normally instead of toggling the menu.
      if (event.target && event.target.closest && event.target.closest('.typecho-engine-menu')) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleEngineMenu(item);
      } else if (event.key === 'Escape') {
        closeEngineMenus();
      }
    });
    engineButtons.push(item);
    return item;
  }

  function createFallbackButton(box) {
    var actions = box.querySelector('.typecho-engine-fallback-actions');
    if (!actions || actions.querySelector('.typecho-engine-fallback-btn')) return;
    var wrapper = document.createElement('span');
    wrapper.className = 'typecho-engine-fallback-menu typecho-engine-menu-trigger';
    wrapper.style.position = 'relative';
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-xs typecho-engine-fallback-btn';
    button.innerHTML = ENGINE_ICON;
    button.title = '写作';
    button.setAttribute('aria-label', '写作');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    wrapper.appendChild(button);
    wrapper.appendChild(createEngineMenu(box));
    button.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      toggleEngineMenu(wrapper);
    });
    actions.appendChild(wrapper);
    engineButtons.push(button);
    box.hidden = false;
  }

  function mountButton(box) {
    if (document.getElementById('wmd-engine-button')) return true;
    var row = document.getElementById('wmd-button-row');
    if (!row) return false;

    var spacer = document.createElement('li');
    spacer.className = 'wmd-spacer typecho-engine-spacer';
    row.appendChild(spacer);
    row.appendChild(createToolbarButton(box));
    box.hidden = false;
    box.classList.add('typecho-engine-mounted');
    return true;
  }

  function wireModalEvents() {
    var modal = document.querySelector('.typecho-engine-modal');
    if (!modal || modal.getAttribute('data-wired') === '1') return;
    modal.setAttribute('data-wired', '1');

    function closeModal() {
      closePreviewModal(true);
    }

    modal.querySelectorAll('.typecho-engine-modal-tab').forEach(function(button) {
      button.addEventListener('click', function() {
        setModalTab(button.getAttribute('data-engine-tab') || 'write');
      });
    });
    modal.querySelector('.typecho-engine-modal-write').addEventListener('input', function() {
      previewState.userEdited = true;
      previewState.currentText = this.value;
      renderModalViews();
      updateModalControls();
    });
    // 比对双栏同步滚动（双向互绑；程序化赋值与用户滚动都走同一事件通道）
    var compareOriginal = modal.querySelector('.typecho-engine-modal-compare-original');
    var compareGenerated = modal.querySelector('.typecho-engine-modal-compare-generated');
    compareOriginal.addEventListener('scroll', function() {
      onCompareScroll(compareOriginal, compareGenerated);
    });
    compareGenerated.addEventListener('scroll', function() {
      onCompareScroll(compareGenerated, compareOriginal);
    });
    modal.querySelector('.typecho-engine-modal-close').addEventListener('click', closeModal);
    modal.querySelector('.typecho-engine-modal-cancel').addEventListener('click', closeModal);
    modal.querySelector('.typecho-engine-modal-confirm').addEventListener('click', confirmInsert);
    modal.querySelector('.typecho-engine-modal-followup-input').addEventListener('keydown', function(event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendFollowUp();
      }
    });
    modal.addEventListener('click', function(event) {
      if (event.target === modal) closePreviewModal(true);
    });
  }

  function initEngine() {
    var box = document.querySelector('.typecho-engine');
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
    document.addEventListener('DOMContentLoaded', initEngine);
  } else {
    initEngine();
  }
  document.addEventListener('click', function(event) {
    if (event.target && event.target.closest && event.target.closest('.typecho-engine-menu')) return;
    closeEngineMenus();
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
  registerPluginAdminPath(CONFIG_API_ROUTE);

  addHook('admin:writePost:bottom', pluginId, (html: string) => html + POST_EDITOR_HTML);
  addHook('admin:writePage:bottom', pluginId, (html: string) => html + PAGE_EDITOR_HTML);

  addHook('admin:page', pluginId, async (html: string, extra?: {
    slug?: string;
    csrfToken?: string;
    options?: Record<string, unknown>;
  }) => {
    if (!isEngineAdminSlug(extra?.slug)) return html;
    return adminPageHtml(String(extra?.csrfToken || ''), loadSettings(extra?.options));
  });

  addHook('admin:footer', pluginId, (html: string, extra?: { activeMenu?: string; user?: { group?: string } }) => {
    const isAdmin = extra?.user?.group && hasPermission(extra.user.group, 'administrator');
    if (!isAdmin) return html;
    const active = extra?.activeMenu === ADMIN_PAGE_SLUG;
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
  insertAfter(4,'/admin/options-permalink','/admin/plugin/engine','智能引擎',${active ? 'true' : 'false'});
})();
</script>`;
  });

  addHook('archive:footer', pluginId, (html: string, extra?: { options?: Record<string, unknown> }) => {
    const provider = loadSettings(extra?.options).searchProvider;
    return html + searchClientHtml(provider, String(extra?.options?.siteUrl || ''));
  });

  addHook(
    'route:request',
    pluginId,
    async (result: PluginRouteResult, extra?: {
      path?: string;
      request?: Request;
      db?: Database;
      options?: Record<string, unknown>;
    }) => {
      if (result?.handled || !extra?.request) return result;
      if (loadSettings(extra.options).searchProvider !== 'default' && await isInternalSearchRequest(extra.request)) {
        return { handled: true, response: searchDisabledResponse() };
      }
      if (extra.path !== CONFIG_API_ROUTE) return result;
      return handleConfigSave(extra);
    },
  );

  addHook('post:finishPublish', pluginId, scheduleSummaryMaterialize);
  addHook('page:finishPublish', pluginId, scheduleSummaryMaterialize);

  addHook(
    'plugin:config:beforeSave',
    pluginId,
    async (result: ConfigValidationResult, extra?: { pluginId?: string; settings?: Record<string, unknown> }) => {
      if (extra?.pluginId !== pluginId) return result;

      try {
        const settings = await validateConfig(extra.settings || {});
        const engineSettings = validateSettings(extra.settings || {});
        return {
          success: true,
          settings: {
            ...settings,
            autoSummary: engineSettings.autoSummary,
            searchProvider: engineSettings.searchProvider,
          },
        };
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
      if (['summarizeOne', 'listForSummary'].includes(extra?.action || '')) return 'administrator';
      return defaultRole;
    },
  );

  addHook(
    `plugin:${pluginId}:action`,
    pluginId,
    async (
      result: PluginActionResult,
      extra?: {
        action?: string;
        payload?: WriterPayload & { cid?: number | string };
        options?: Record<string, unknown>;
        db?: Database;
      },
    ) => {
      const action = extra?.action || '';

      if (action === 'listForSummary') {
        if (!extra?.db) {
          return { handled: true, success: false, error: '数据库不可用' };
        }
        try {
          const items = await listPublishedForSummary(extra.db);
          return { handled: true, success: true, items };
        } catch (error) {
          return {
            handled: true,
            success: false,
            error: error instanceof Error ? error.message : '加载列表失败',
          };
        }
      }

      if (action === 'summarizeOne') {
        if (!extra?.db) {
          return { handled: true, success: false, error: '数据库不可用' };
        }
        const cid = Number(extra.payload?.cid);
        if (!Number.isInteger(cid) || cid <= 0) {
          return { handled: true, success: false, error: '缺少有效的 cid' };
        }
        try {
          const summary = await summarizeOneCid(extra.db, extra.options || {}, cid);
          return { handled: true, success: true, cid, summary };
        } catch (error) {
          return {
            handled: true,
            success: false,
            error: error instanceof Error ? error.message : '摘要生成失败',
          };
        }
      }

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

async function handleConfigSave(extra: {
  request?: Request;
  db?: Database;
  options?: Record<string, unknown>;
}): Promise<PluginRouteResult> {
  const request = extra.request!;
  const db = extra.db;
  const options = extra.options || {};

  if (!db) {
    return {
      handled: true,
      response: new Response(JSON.stringify({ success: false, message: '数据库不可用' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    };
  }

  if (request.method !== 'POST') {
    return {
      handled: true,
      response: new Response(JSON.stringify({ success: false, message: 'Method Not Allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    };
  }

  const auth = await authenticateAdmin(request, db, options);
  if (auth instanceof Response) {
    return {
      handled: true,
      response: new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), {
        status: auth.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    };
  }

  const csrfError = await requireAdminCSRF(
    request,
    String(options.secret || ''),
    String(auth.authCode || ''),
    auth.uid,
  );
  if (csrfError) {
    return {
      handled: true,
      response: new Response(JSON.stringify({ success: false, message: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    };
  }

  if (!isSameOriginRequest(request, String(options.siteUrl || ''))) {
    return {
      handled: true,
      response: new Response(JSON.stringify({ success: false, message: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    };
  }

  try {
    const body = await request.json() as { settings?: Record<string, unknown> };
    if (!body.settings || typeof body.settings !== 'object') {
      return {
        handled: true,
        response: new Response(JSON.stringify({ success: false, message: '请提供配置数据' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }),
      };
    }

    const previous = toFormValues(loadSettings(options));
    const restored = restoreSecretFormValues(body.settings, previous);
    const settings = validateSettings(restored);
    await setOption(db, `plugin:${PLUGIN_ID}`, JSON.stringify(settings));
    return {
      handled: true,
      response: new Response(JSON.stringify({
        success: true,
        message: '设置已保存',
        settings: maskSecretFormValues(toFormValues(settings)),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    };
  } catch (error) {
    console.error(`[${PLUGIN_ID}] 保存设置失败:`, error);
    return {
      handled: true,
      response: new Response(JSON.stringify({
        success: false,
        message: error instanceof Error ? error.message : '保存失败',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    };
  }
}

async function authenticateAdmin(
  request: Request,
  db: Database,
  options: Record<string, unknown>,
): Promise<{ uid: number; authCode: string } | Response> {
  const { token } = getAuthCookies(request.headers.get('cookie'));
  if (!token || !options.secret) {
    return new Response('Unauthorized', { status: 401 });
  }

  const auth = await validateAuthToken(token, String(options.secret), db);
  if (!auth) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!hasPermission(auth.user.group || 'visitor', 'administrator')) {
    return new Response('Forbidden', { status: 403 });
  }

  return {
    uid: auth.uid,
    authCode: String(auth.user.authCode || ''),
  };
}

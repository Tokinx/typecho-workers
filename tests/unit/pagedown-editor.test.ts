/**
 * Regression tests for the WMD/PageDown editor commands vendored at
 * public/vendor/pagedown.js:
 *
 * - 链接/图片以内联形式插入：[text](url) / ![desc](url)
 * - 多行代码段使用 ``` 围栏，单行代码段使用单个反引号
 *
 * The vendored file is minified and browser-oriented, so the two command
 * bodies are extracted and loaded through a temporary CJS module.
 */
import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VENDOR_PATH = path.resolve(process.cwd(), 'public/vendor/pagedown.js');
const TMP_MODULE = path.join(os.tmpdir(), 'typecho-pagedown-commands.cjs');

interface Chunk {
  before: string;
  selection: string;
  after: string;
  startTag: string;
  endTag: string;
}

interface Commands {
  doCode: (chunk: Chunk, post: () => void) => unknown;
  doLinkOrImage: (chunk: Chunk, post: () => void, isImage: boolean) => boolean;
}

// `w` is a free variable inside doLinkOrImage (the editor UI helper).
const originalW = (globalThis as Record<string, unknown>).w;
(globalThis as Record<string, unknown>).w = {
  createBackground: () => ({ parentNode: { removeChild: () => {} } }),
  prompt: () => {
    throw new Error('prompt fallback should not be needed when hooks handle the dialog');
  },
};

function extractBody(startMarker: RegExp, endMarker: RegExp, src: string): string {
  const a = src.search(startMarker);
  if (a === -1) throw new Error(`start marker missing: ${startMarker}`);
  const matched = src.slice(a).match(startMarker);
  if (!matched) throw new Error(`start marker missing: ${startMarker}`);
  const bodyStart = a + matched[0].length;
  const b = src.slice(bodyStart).search(endMarker);
  if (b === -1) throw new Error(`end marker missing: ${endMarker}`);
  return src.slice(bodyStart, bodyStart + b);
}

async function loadPatchedCommands(): Promise<Commands> {
  const src = fs.readFileSync(VENDOR_PATH, 'utf8');
  const doCodeBody = extractBody(/\be\.doCode\s*=\s*function/, /, e\.doList\s*=\s*function/, src);
  const doLinkBody = extractBody(/\be\.doLinkOrImage\s*=\s*function/, /, e\.doAutoindent\s*=\s*function/, src);
  fs.writeFileSync(TMP_MODULE, `module.exports = { doCode: function ${doCodeBody}, doLinkOrImage: function ${doLinkBody} };\n`);
  const mod = (await import(pathToFileURL(TMP_MODULE).href)) as unknown as Commands;
  fs.unlinkSync(TMP_MODULE);
  return mod;
}

/**
 * Chunk helpers mirroring the vendored module's own trimWhitespace /
 * findTags semantics so the extracted commands run as in the browser.
 */
function makeChunk(before: string, selection: string, after: string): Chunk {
  const chunk: Chunk = { before, selection, after, startTag: '', endTag: '' };
  (chunk as Chunk & { trimWhitespace: () => void }).trimWhitespace = () => {
    chunk.selection = chunk.selection
      .replace(/^(\s*)/, (m) => { chunk.before += m; return ''; })
      .replace(/(\s*)$/, (m) => { chunk.after = m + chunk.after; return ''; });
  };
  (chunk as Chunk & { findTags: (b: RegExp, a: RegExp) => void }).findTags = (beforeTag, afterTag) => {
    chunk.startTag = '';
    chunk.endTag = '';
    if (beforeTag) {
      chunk.before = chunk.before.replace(new RegExp(beforeTag.source + '$', 'g'), (m) => { chunk.startTag += m; return ''; });
      chunk.selection = chunk.selection.replace(new RegExp('^' + beforeTag.source, 'g'), (m) => { chunk.startTag += m; return ''; });
    }
    if (afterTag) {
      chunk.selection = chunk.selection.replace(new RegExp(afterTag.source + '$', 'g'), (m) => { chunk.endTag = m + chunk.endTag; return ''; });
      chunk.after = chunk.after.replace(new RegExp('^' + afterTag.source, 'g'), (m) => { chunk.endTag = m + chunk.endTag; return ''; });
    }
  };
  return chunk;
}

function apply(chunk: Chunk): string {
  return chunk.before + chunk.startTag + chunk.selection + chunk.endTag + chunk.after;
}

const STRINGS: Record<string, string | undefined> = {
  codeexample: 'codeexample',
  imagedescription: 'image-desc',
  linkdescription: 'link-desc',
};

function runCode(commands: Commands, before: string, selection: string, after: string): string {
  const chunk = makeChunk(before, selection, after);
  const returned = commands.doCode.call({ getString: (k: string) => STRINGS[k] }, chunk, () => {});
  // the editor command executor applies the chunk when the command returns falsy
  return returned ? '' : apply(chunk);
}

function runLinkOrImage(commands: Commands, before: string, selection: string, after: string, url: string | null, isImage: boolean): string {
  const chunk = makeChunk(before, selection, after);
  let result = '';
  const editor = {
    getString: (k: string) => STRINGS[k],
    hooks: {
      commandExecuted: () => {},
      [isImage ? 'insertImageDialog' : 'insertLinkDialog']: (cb: (u: string | null) => void) => {
        cb(url);
        return true;
      },
    },
  };
  const returned = commands.doLinkOrImage.call(editor, chunk, () => { result = apply(chunk); }, isImage);
  if (!returned) result = apply(chunk);
  return result;
}

describe('pagedown editor commands (public/vendor/pagedown.js)', () => {
  const commandsPromise = loadPatchedCommands();
  afterAll(() => {
    (globalThis as Record<string, unknown>).w = originalW;
  });

  describe('doCode：多行用 ``` 围栏，单行用单个 `', () => {
    it('多行选区 → 围栏包裹', async () => {
      const commands = await commandsPromise;
      expect(runCode(commands, '', 'a\nb', '')).toBe('```\na\nb\n```');
    });

    it('多行选区带旧式 4 空格缩进 → 去缩进并包裹', async () => {
      const commands = await commandsPromise;
      expect(runCode(commands, '', '    a\n    b', '')).toBe('```\na\nb\n```');
    });

    it('多行选区位于行中 → 围栏前补换行；后紧跟文本 → 围栏后补换行', async () => {
      const commands = await commandsPromise;
      expect(runCode(commands, 'xx', 'a\nb', 'yy')).toBe('xx\n```\na\nb\n```\nyy');
    });

    it('已是围栏代码块（含语言标记）→ 解除围栏', async () => {
      const commands = await commandsPromise;
      expect(runCode(commands, '', '```js\na\nb\n```', '')).toBe('a\nb');
    });

    it('单行选区 → 单个反引号（行首块级上下文也保持）', async () => {
      const commands = await commandsPromise;
      expect(runCode(commands, '', 'foo', '')).toBe('`foo`');
      expect(runCode(commands, '', 'foo', '\n')).toBe('`foo`\n');
    });

    it('无选区 → 内联占位符', async () => {
      const commands = await commandsPromise;
      expect(runCode(commands, 'hello wor', '', 'ld')).toBe('hello wor`codeexample`ld');
    });

    it('已被反引号包裹 → 移除反引号', async () => {
      const commands = await commandsPromise;
      expect(runCode(commands, 'x `', 'foo', '` y')).toBe('x foo y');
    });
  });

  describe('doLinkOrImage：内联 [text](url) / ![desc](url)', () => {
    it('链接：普通选区', async () => {
      const commands = await commandsPromise;
      expect(runLinkOrImage(commands, '', 'Google', '', 'https://x.com', false)).toBe('[Google](https://x.com)');
    });

    it('链接：无选区 → 占位描述', async () => {
      const commands = await commandsPromise;
      expect(runLinkOrImage(commands, '', '', '', 'https://x.com', false)).toBe('[link-desc](https://x.com)');
    });

    it('链接：选区含方括号 → 转义', async () => {
      const commands = await commandsPromise;
      expect(runLinkOrImage(commands, '', 'a[b]c', '', 'https://x.com', false)).toBe('[a\\[b\\]c](https://x.com)');
    });

    it('链接：已有内联标记 → 移除标记（toggle-off）', async () => {
      const commands = await commandsPromise;
      expect(runLinkOrImage(commands, 'xx [', 'text', '](https://x.com)', '', false)).toBe('xx text');
      expect(runLinkOrImage(commands, 'xx ', '[text](https://x.com)', '', '', false)).toBe('xx text');
    });

    it('链接：取消 → 不变', async () => {
      const commands = await commandsPromise;
      expect(runLinkOrImage(commands, 'before ', 'sel', ' after', null, false)).toBe('before sel after');
    });

    it('图片：普通选区', async () => {
      const commands = await commandsPromise;
      expect(runLinkOrImage(commands, '', 'alt', '', 'https://img/x.png', true)).toBe('![alt](https://img/x.png)');
    });

    it('图片：无选区 → 占位描述', async () => {
      const commands = await commandsPromise;
      expect(runLinkOrImage(commands, '', '', '', 'https://img/x.png', true)).toBe('![image-desc](https://img/x.png)');
    });

    it('图片：已有内联标记 → 移除标记（toggle-off）', async () => {
      const commands = await commandsPromise;
      expect(runLinkOrImage(commands, 'xx ![', 'alt', '](https://img/x.png)', '', true)).toBe('xx alt');
      expect(runLinkOrImage(commands, 'xx ', '![alt](https://img/x.png)', '', '', true)).toBe('xx alt');
    });

    it('图片：取消 → 不变', async () => {
      const commands = await commandsPromise;
      expect(runLinkOrImage(commands, '', 'alt', '', null, true)).toBe('alt');
    });
  });
});
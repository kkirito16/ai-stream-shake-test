// streamMarkdownSanitizer.ts
// 流式 Markdown 消歧：处理流式逐字接收时行内标记的「符号闪现」问题。
//
// 问题：逐字接收时，`**abc**` 会先显示裸的 `**`，等闭合符号到了才「突然变粗」，
//       行内代码 `code`、斜体 *x*、删除线 ~~x~~、链接 [t](u) 同理，符号一闪一闪。
//
// 方案：在「送去渲染之前」，对末尾**未闭合的行内标记**做处理：
//   1) 裸符号（刚冒头、后面还没内容）→ 裁掉，先不显示；
//   2) 已有内容但未闭合 → 乐观补上「虚拟闭合符」，让 markdown-it 直接解析成
//      strong/em/code/del，于是内容以「最终样式」逐字出现，特殊符号从不露面。
//
// 关键不变量：对「已完整闭合」的文本，本函数是恒等变换（不改一个字），
//            因此流式结束态永远等于原始全文，绝不丢字符。

/**
 * 对流式过程中的「已消费文本」做行内标记消歧，返回用于渲染的展示文本。
 */
export function sanitizeStreamingMarkdown(raw: string): string {
  if (!raw) return raw;

  // 未闭合的围栏代码块 ``` 内：符号本就该原样显示，直接返回不做行内消歧。
  if (((raw.match(/```/g) || []).length) % 2 === 1) return raw;

  let text = raw;
  text = cutIncompleteHtmlTag(text); // 未闭合的 <tag / </tag 碎片 → 暂时隐藏
  text = cutIncompleteLink(text);    // 未完成的 [t](u) / ![t](u) → 暂时隐藏
  text = balanceBacktick(text);      // 行内代码 `
  text = balanceStars(text);         // 加粗 ** / 斜体 *
  text = balanceTilde(text);         // 删除线 ~~
  return text;
}

/**
 * 处理末尾「正在输入、尚未闭合」的 HTML 标签碎片。
 * 逐字接收时 `<blue>港股</blue>` 会先冒出 `<`、`<blue`、`</blue` 这类半截标签
 * （markdown-it 把未补 `>` 的部分当纯文本 text 显示），补 `>` 后才变成
 * html_inline 被渲染层丢弃。这一闪一消就是「标签闪烁」。
 *
 * 策略：若末尾存在一个尚未配对 `>` 的 `<`，且它看起来像标签起始
 * （`<x` / `</x` / 末尾单个 `<`），就从该 `<` 处裁断，等 `>` 到齐再显示。
 * 对「a < b」这类比较号（`<` 后紧跟空格）不误伤；对已闭合标签恒等不变。
 */
function cutIncompleteHtmlTag(text: string): string {
  const lt = text.lastIndexOf('<');
  if (lt === -1) return text;

  const rest = text.slice(lt);
  if (rest.includes('>')) return text; // 该 `<` 已闭合 → 不处理

  // 像标签起始的碎片 → 从 `<` 处隐藏。覆盖逐字到达的各阶段：
  //   `<`（单个）、`</`（斜杠先到、标签名未到）、`<x`、`</x`、`<blue`、`</blue`
  // 判据：`<` 后第二个字符是 `/` 或字母，或就是末尾单个 `<`。
  // 对 `a < b`（`<` 后是空格/数字）等比较号不误伤；已闭合标签含 `>` 前面已返回。
  if (rest === '<' || /^<[/a-zA-Z]/.test(rest)) {
    return text.slice(0, lt);
  }
  return text; // 其它（如 `< ` 比较号）→ 保留
}

/**
 * 处理末尾「正在输入、尚未闭合」的链接 / 图片。
 * [text](url) 需要 4 段齐全才成立；缺任何一段都先从 `[` 处隐藏，等补齐再显示，
 * 避免出现 `[`、`[text]`、`[text](htt` 这类中间态闪现。
 */
function cutIncompleteLink(text: string): string {
  const lb = text.lastIndexOf('[');
  if (lb === -1) return text;

  // 若 `[` 前面是 `!`，把图片的 `!` 也一起视为起点
  const start = lb > 0 && text[lb - 1] === '!' ? lb - 1 : lb;
  const rest = text.slice(start);

  // 已构成完整链接/图片 → 不处理
  if (/^!?\[[^\]]*\]\([^)]*\)/.test(rest)) return text;

  // 未闭合（还没到 `]` 或 `](...)` 未收尾）→ 从起点隐藏
  return text.slice(0, start);
}

/**
 * 行内代码 `：反引号总数为奇数说明末尾有未闭合的行内代码。
 * 裸的 `（后面没内容）→ 裁掉；已有内容 → 末尾补一个 ` 闭合。
 */
function balanceBacktick(text: string): string {
  const stripped = text.replace(/```/g, ''); // 排除围栏（已保证成对）
  if ((stripped.match(/`/g) || []).length % 2 === 0) return text;

  const last = text.lastIndexOf('`');
  const after = text.slice(last + 1);
  if (after.trim() === '') return text.slice(0, last); // 裸符号 → 裁掉
  return text + '`';                                   // 补闭合
}

/**
 * 加粗 ** 与斜体 *。
 * 策略：连续星号 run，len>=2 视为「**」定界，len==1 视为「*」定界；
 * 各自的定界数为奇数即末尾未闭合，按「裸符号裁掉 / 有内容补闭合」处理。
 * 先处理 **，再在结果上处理单 *（保证完整闭合文本恒等不变）。
 */
function balanceStars(text: string): string {
  let result = closeMarker(text, 2); // 处理 **
  result = closeMarker(result, 1);   // 处理 *
  return result;
}

/**
 * 判断位于 pos 的单个 `*` 是否是无序列表的项目符号（bullet），而非斜体定界符。
 * 依据 Markdown 规则：bullet 需位于行首（前面只有空白缩进），且后面紧跟空白。
 * 例：`* 项目`、`  *  文本` 里的 `*` 都是列表标记，不该计入斜体统计。
 */
function isListBullet(text: string, pos: number): boolean {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const before = text.slice(lineStart, pos);
  if (!/^\s*$/.test(before)) return false; // 前面有非空白 → 不是行首标记
  const afterChar = text[pos + 1];
  return afterChar === ' ' || afterChar === '\t'; // 后跟空白才是合法 bullet
}

/**
 * @param width 2 -> 处理 **（加粗）；1 -> 处理 *（斜体）
 */
function closeMarker(text: string, width: 1 | 2): string {
  const runs: Array<{ pos: number; len: number }> = [];
  const re = /\*+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) runs.push({ pos: m.index, len: m[0].length });

  // 统计目标宽度的定界符数量与最后一次出现位置
  let count = 0;
  let lastPos = -1;
  for (const r of runs) {
    const isDouble = r.len >= 2;
    if (width === 2 && isDouble) {
      count += 1;
      lastPos = r.pos;
    } else if (width === 1 && r.len === 1) {
      // 行首的列表项标记 `* ` 不是斜体定界符，排除以免污染奇偶判断
      if (isListBullet(text, r.pos)) continue;
      count += 1;
      lastPos = r.pos;
    }
  }
  if (count % 2 === 0 || lastPos === -1) return text; // 已配对，恒等

  const marker = width === 2 ? '**' : '*';
  const after = text.slice(lastPos + width);
  if (after.trim() === '') {
    return text.slice(0, lastPos); // 裸符号刚冒头 → 裁掉
  }
  return text + marker;            // 有内容未闭合 → 乐观补闭合
}

/**
 * 删除线 ~~：出现次数为奇数说明未闭合。
 */
function balanceTilde(text: string): string {
  if ((text.match(/~~/g) || []).length % 2 === 0) return text;
  const last = text.lastIndexOf('~~');
  const after = text.slice(last + 2);
  if (after.trim() === '') return text.slice(0, last);
  return text + '~~';
}

// streamMarkdownSanitizer.ts
// 流式 Markdown 消歧：处理流式逐字接收时「符号闪现」问题（行内标记 + 块级表格）。
//
// 问题 A（行内）：逐字接收时，`**abc**` 会先显示裸的 `**`，等闭合符号到了才「突然变粗」，
//       行内代码 `code`、斜体 *x*、删除线 ~~x~~、链接 [t](u) 同理，符号一闪一闪。
// 问题 B（块级表格）：GFM 表格必须「表头行 + 分隔行 |---| 」两行齐全才成立。流式时表头
//       先到、分隔行还没来，markdown-it 只能把 `| 指标 |` 当普通段落，于是裸竖线闪现，
//       等分隔行到齐才突变成表格。
//
// 方案：在「送去渲染之前」，先做块级表格消歧，再做行内标记消歧：
//   块级：表头逐字输入中→暂时隐藏；表头定格但分隔行未齐→按表头列数合成完整分隔行，
//         让 md 立刻成表（先出框架再填数据）；分隔行已列数匹配→恒等。
//   行内：1) 裸符号（刚冒头、后面还没内容）→ 裁掉，先不显示；
//         2) 已有内容但未闭合 → 乐观补上「虚拟闭合符」，让 markdown-it 直接解析成
//            strong/em/code/del，内容以「最终样式」逐字出现，特殊符号从不露面。
//
// 关键不变量：对「已完整闭合/已成表」的文本，本函数是恒等变换（不改一个字），
//            因此流式结束态永远等于原始全文，绝不丢字符。

/**
 * 对流式过程中的「已消费文本」做消歧，返回用于渲染的展示文本。
 */
export function sanitizeStreamingMarkdown(raw: string): string {
  if (!raw) return raw;

  // 未闭合的围栏代码块 ``` 内：符号本就该原样显示，直接返回不做消歧。
  if (((raw.match(/```/g) || []).length) % 2 === 1) return raw;

  let text = raw;
  text = sanitizeStreamingTable(text); // 块级：表格「表头/分隔行」未齐时的裸竖线闪现
  text = cutIncompleteHtmlTag(text); // 未闭合的 <tag / </tag 碎片 → 暂时隐藏
  text = cutIncompleteLink(text);    // 未完成的 [t](u) / ![t](u) → 暂时隐藏
  text = balanceBacktick(text);      // 行内代码 `
  text = balanceStars(text);         // 加粗 ** / 斜体 *
  text = balanceTilde(text);         // 删除线 ~~
  return text;
}

// ============================ 块级：表格消歧 ============================
//
// GFM 表格成立条件：连续两行「表头行 + 分隔行」，且分隔行列数 == 表头列数。
// 流式逐字到达时的典型序列（会闪裸竖线的只有「未成表」阶段）：
//   | 指标                      ← 表头输入中（未换行，列数未定）→ 隐藏
//   | 指标 | 涨跌 |             ← 表头输入中 → 隐藏
//   | 指标 | 涨跌 |\n           ← 表头定格、分隔行0字 → 合成 | --- | --- | 立即成表
//   | 指标 | 涨跌 |\n|          ← 分隔行半截 → 合成完整分隔行顶上
//   | 指标 | 涨跌 |\n| ---      ← 分隔行半截(列数不足) → 合成完整分隔行顶上
//   | 指标 | 涨跌 |\n| --- | ---← 分隔行列数已匹配(GFM 不需尾|) → 恒等，md 自然成表
//   | 指标 | 涨跌 |\n| --- | --- |\n| 6/23 ← 已成表，数据行在表格上下文内，不闪 → 恒等

/** 整行是否为分隔行：只由 | - : 空格 组成且至少含一个 - 。 */
function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (!/^[|\-:\s]+$/.test(t)) return false;
  return t.includes('-');
}

/** 数一行的列数：去掉首尾 | 后按 | 切分。`| a | b |` → 2；`| 指标 |` → 1。 */
function tableColumns(line: string): number {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').length;
}

/** 按列数合成一条完整分隔行：cols=2 → `| --- | --- |`。 */
function makeDelimiterRow(cols: number): string {
  return '| ' + Array(cols).fill('---').join(' | ') + ' |';
}

/**
 * 表格块级消歧：只处理文本「末尾正在形成的表格块」。
 * - 已成表（分隔行列数匹配）→ 恒等；
 * - 表头输入中（未换行、无分隔行）→ 隐藏表头行；
 * - 表头定格 / 分隔行未齐 → 合成完整分隔行，立即成表。
 */
function sanitizeStreamingTable(text: string): string {
  if (!text.includes('|')) return text; // 没竖线，肯定没表格

  const lines = text.split('\n');
  const n = lines.length;
  const endsWithNL = lines[n - 1] === ''; // 末尾换行 → 最后一"实"行是 n-2
  const topIdx = endsWithNL ? n - 2 : n - 1;
  if (topIdx < 0) return text;

  // 向上收集连续含 '|' 的行，构成末尾表格块（空行/不含|的普通行会中断表格）
  let s = topIdx;
  while (s >= 0 && lines[s].includes('|')) s--;
  const blockStart = s + 1;
  if (blockStart > topIdx) return text; // 末尾实行不含 | → 非表格块，交给行内层

  const header = lines[blockStart];
  // 强信号约束：只处理「行首以 | 起」的表头，避免把普通句子里的竖线
  // （如 `价格 100 | 200 元`、`命令 a | b`）误判成表头而错补分隔行、破坏恒等。
  // 真实 AI 输出的表格表头几乎总带首竖线（`| 指标 |`），此约束足够安全。
  if (!header.trim().startsWith('|')) return text;
  const cols = tableColumns(header);
  if (cols < 1) return text;

  const secondIdx = blockStart + 1; // 分隔行应在的位置
  const hasSecond = secondIdx <= topIdx;

  // 已成表：分隔行存在且列数匹配 → 恒等（数据行阶段在表格上下文内，不闪）
  if (hasSecond && isDelimiterRow(lines[secondIdx]) && tableColumns(lines[secondIdx]) === cols) {
    return text;
  }

  // 未成表：分几种情况处理
  if (!hasSecond) {
    // 块内只有表头行
    if (endsWithNL) {
      // 表头已换行、分隔行 0 字 → 合成分隔行接上，立即成表（先出框架）
      return [...lines.slice(0, topIdx + 1), makeDelimiterRow(cols)].join('\n');
    }
    // 表头还在逐字输入（未换行）→ 隐藏表头行，避免裸竖线闪现
    return lines.slice(0, blockStart).join('\n');
  }

  // 有第二行但不是「列数匹配的合法分隔行」（半截 / 列数不足 / 空 |）
  // → 用表头列数合成完整分隔行顶上，丢弃半截，保持成表状态
  const before = lines.slice(0, blockStart);
  return [...before, header, makeDelimiterRow(cols)].join('\n');
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
  return appendCloser(text, '`');                      // 补闭合（避开末尾空白）
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
  return appendCloser(text, marker); // 有内容未闭合 → 乐观补闭合
}

/**
 * 乐观补闭合符时的两个关键细节：
 * 1) 闭合定界符（** / * / ~~ / `）**不能紧跟在空白之后**，否则不构成 right-flanking，
 *    整对标记解析失败、开头的定界符会以字面量露出来（逐字到达时正文常停在「… 空格」处，
 *    例如 `**腾讯…跌破 4 `，直接末尾补 ** 会失效）。→ 末尾空白必须留在闭合符外部。
 * 2) 末尾若已冒出「新一轮同类标记的碎片」（如 `**abc：*` 里刚到的单个 `*`），直接补会
 *    拼成 `***` 又露一个符号。这种刚冒头、还没内容的碎片先**隐藏**，下一 tick 内容到了
 *    会自然重算（本函数每次都从 raw 全量重算，隐藏是暂时的，不丢字）。
 *
 * 做法：先剥掉末尾空白，再剥掉紧贴的同类标记碎片得到真实内容 core；
 *      闭合符贴到 core 之后，末尾空白原样接回标记外部。
 */
function appendCloser(text: string, marker: string): string {
  const markerChar = marker[0];
  const wsMatch = text.match(/\s+$/);
  const trailingWs = wsMatch ? wsMatch[0] : '';
  const noWs = trailingWs ? text.slice(0, text.length - trailingWs.length) : text;
  // 剥掉紧贴末尾的同类标记碎片（如末尾多出的 * 或 `）
  const escaped = markerChar === '*' ? '\\*' : markerChar;
  const core = noWs.replace(new RegExp(`${escaped}+$`), '');
  if (!core) return text; // 全是标记/空白，无实际内容 → 不动
  return core + marker + trailingWs;
}

/**
 * 删除线 ~~：出现次数为奇数说明未闭合。
 */
function balanceTilde(text: string): string {
  if ((text.match(/~~/g) || []).length % 2 === 0) return text;
  const last = text.lastIndexOf('~~');
  const after = text.slice(last + 2);
  if (after.trim() === '') return text.slice(0, last);
  return appendCloser(text, '~~');
}

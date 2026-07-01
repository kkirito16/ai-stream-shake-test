#!/usr/bin/env node
/**
 * 生成脱敏示例 SSE 报文文件 src/mock/stream-sample.text。
 * 模拟真实后端结构：role -> reasoning_content(多条思考) -> content(粒度不均) -> 空包 -> [DONE]。
 * 内容中性、可公开。运行：node scripts/gen-sample-stream.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const currentDirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(currentDirname, '../src/mock/stream-sample.text');

const ID = 'chatcmpl-sample000000000000000000000000';
const CREATED = 1782207956;
const MODEL = 'mock-llm';

// 思考过程（拆成小片，模拟 reasoning 逐字/逐词吐出）
const reasoning = [
  '用户', '想了解', 'AI ', '问答', '里', '流式', '打字机', '效果', '的',
  '实现', '思路', '。', '我', '需要', '从', '「', '后端', '按 chunk ',
  '推送', '」', '和', '「', '前端', '逐字', '上屏', '」', '两个', '角度',
  '来', '解释', '，', '并', '说明', '卡顿', '的', '来源', '。',
];

// 正文（一段 Markdown 回答），随后会被切成「粒度不均」的多条 content chunk
const answer = `## 流式打字机效果实现要点

在 AI 问答场景里，**丝滑的逐字上屏**并不是简单地把后端返回拼接显示，而是要处理好三件事。

### 一、后端按 chunk 推送

后端通常以 SSE（\`data: {...}\`）逐块下发，每个 chunk 的内容大小很不均匀：

1. 有大量 **1~2 个字**的小包；
2. 偶尔一次吐出一整段（burst）；
3. 中间还夹着思考、调用工具的**停顿期**，此时正文完全不动。

> 这种「粒度不均 + 停顿」正是卡顿感的真正来源。

### 二、前端逐字上屏

前端不应该「来多少显示多少」，而应把到达的内容先放进缓冲区，再由一个稳定的节拍器按 *固定速度* 逐字取出上屏。这样做的好处是：

- 后端瞬间返回一大段，也会被缓冲区拦住、匀速放出；
- 后端卡顿时，缓冲区里还有存货可以继续吐，屏幕不会停。

### 三、渲染层优化

配合增量解析与节流滚动，就能得到稳定、无抖动的打字机效果。整体思路是把「产出」与「上屏」彻底解耦，让体验只由前端节奏决定。

### 四、三种方案对比

| 方案 | 上屏方式 | 卡顿表现 | 适用场景 |
| --- | --- | :---: | --- |
| 直接拼接 | 来多少显示多少 | 明显跳变 | 简单文本 |
| **缓冲匀速** | 缓冲区 + 节拍器逐字 | 基本无 | **推荐** |
| 绕过缓冲 | 按帧尽快逐字 | 忽快忽停 | 还原真实 |

综合来看，**缓冲匀速**在体验上最稳，是大多数 AI 问答场景的首选。`;

/** 把正文切成粒度不均的片段：多数 1~4 字，偶发一段 */
function splitUneven(text) {
  const arr = Array.from(text); // 正确处理多字节
  const parts = [];
  let i = 0;
  // 用一个确定性的伪随机，保证每次生成一致
  let seed = 20260701;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  while (i < arr.length) {
    const r = rand();
    let n;
    if (r < 0.55) n = 1 + Math.floor(rand() * 2);     // 1~2
    else if (r < 0.80) n = 3 + Math.floor(rand() * 3); // 3~5
    else if (r < 0.95) n = 6 + Math.floor(rand() * 7); // 6~12
    else n = 15 + Math.floor(rand() * 20);             // 15~34 burst
    parts.push(arr.slice(i, i + n).join(''));
    i += n;
  }
  return parts;
}

function chunkObj(delta, finish = null) {
  return {
    id: ID,
    object: 'chat.completion.chunk',
    created: CREATED,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const lines = [];
const push = (obj) => lines.push(`data: ${JSON.stringify(obj)}`);

// 1) role
push(chunkObj({ role: 'assistant' }));
// 2) reasoning_content（思考期，正文不动 → 模拟停顿感）
for (const r of reasoning) push(chunkObj({ reasoning_content: r }));
// 3) 一个空包（思考结束到正文开始之间常见）
push(chunkObj({}));
// 4) content 正文，粒度不均
for (const c of splitUneven(answer)) push(chunkObj({ content: c }));
// 5) 收尾空包 + finish
push(chunkObj({}, 'stop'));
// 6) DONE
lines.push('data: [DONE]');

fs.writeFileSync(OUT, lines.join('\n\n') + '\n', 'utf8');
console.log(`已生成 ${path.relative(process.cwd(), OUT)}，共 ${lines.length} 条报文`);

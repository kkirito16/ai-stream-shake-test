// useStreamSim.ts
// 流式打字机：生产者-消费者模型（参考 KM《万字长文丝滑流式输出》三级增量方案）。
//
// 核心思想：把「后端产出」与「前端上屏」解耦。
//   生产者(模拟后端 SSE)：把目标文本按 chunk + 延迟投递进「缓冲区」；
//   消费者(前端打字机)：以稳定节奏，从缓冲区匀速取字上屏，形成逐字打字机效果。
// 这样：后端再快也不会大段上屏(逐字)，后端慢时消费端等待(不卡)，节奏由 cps 决定(可控)。
//
// 【真实卡顿还原】参考真实项目 scripts/mock-stream-completions-trpc-agent.mjs：
//   真实后端是「按 SSE chunk 推送」，每个 chunk 的 delta.content 大小极不均匀——
//   有空包(delta:{})、大量 1~2 字小包，偶发一整段 burst，且正文中间会因
//   思考/调工具/网络出现「长停顿」。这些毛刺才是卡顿的真正来源。
//   生产者提供 producerMode='realistic' 还原该分布，并可通过 bypassBuffer
//   让 chunk「到达即上屏」以直观对比「原始卡顿 vs 缓冲削峰」的差异。

import { reactive } from 'vue';

export type ProducerMode = 'smooth' | 'realistic';

export interface StreamConfig {
  cps: number;             // 打字速度：目标字/秒（消费速度，主控快慢）
  charsPerTick: number;    // 每帧最多消费字符数（1 最丝滑；调大更省但略跳）
  producerDelayMs: number; // 模拟后端分块到达间隔(ms)，体现缓冲区削峰
  randomDelay: boolean;    // 后端到达间隔加随机抖动（更贴近真实 SSE）
  catchUp: boolean;        // 缓冲积压时自动追赶（防长文拖太久，仍保持平滑）
  producerMode: ProducerMode; // 生产者投递模型：smooth=平滑随机 / realistic=还原真实 chunk 卡顿
  bypassBuffer: boolean;   // 绕过缓冲：chunk 到达即上屏（还原后端原始卡顿，用于对比）
  stallProbability: number; // realistic 模式下，每个 chunk 后触发「长停顿」的概率(0~1)
}

export interface StreamState {
  reasonContent: string;
  content: string;
  isStreaming: boolean;
  isPaused: boolean;
  isThinkingPhase: boolean;
  outputChars: number;
  messageCount: number;
  bufferedChars: number;   // 缓冲区积压字符数（调试可视化）
  stalling: boolean;       // 当前是否处于「后端长停顿」（可视化卡顿来源）
}

export function useStreamSim() {
  const state = reactive<StreamState>({
    reasonContent: '',
    content: '',
    isStreaming: false,
    isPaused: false,
    isThinkingPhase: false,
    outputChars: 0,
    messageCount: 0,
    bufferedChars: 0,
    stalling: false,
  });

  const cfg = reactive<StreamConfig>({
    cps: 40,
    charsPerTick: 1,
    producerDelayMs: 50,
    randomDelay: true,
    catchUp: true,
    producerMode: 'realistic',
    bypassBuffer: false,
    stallProbability: 0.12,
  });

  // 目标全文
  let fullContent = '';
  // 生产者指针：已「到达缓冲区」的字符数
  let producedLen = 0;
  // 消费者指针：已「上屏」的字符数
  let consumedLen = 0;
  let producerDone = false;

  let produceTimer: ReturnType<typeof setTimeout> | null = null;
  let consumeTimer: ReturnType<typeof setTimeout> | null = null;

  let onUpdate: (() => void) | null = null;
  let onDone: (() => void) | null = null;

  function setCallbacks(update: () => void, done?: () => void) {
    onUpdate = update;
    onDone = done || null;
  }

  // ===== chunk 大小分布 =====
  // smooth：固定随机 3~12 字（平滑，抹掉毛刺）
  // realistic：还原真实后端——以 1~2 字小包为主，偶发中包/大 burst，符合真实 SSE 观感
  function nextChunkSize(): number {
    if (cfg.producerMode === 'smooth') {
      return 3 + Math.floor(Math.random() * 10); // 3~12
    }
    // realistic：加权分布
    const r = Math.random();
    if (r < 0.55) return 1 + Math.floor(Math.random() * 2);   // 55% → 1~2 字（真实小包主力）
    if (r < 0.80) return 3 + Math.floor(Math.random() * 3);   // 25% → 3~5 字
    if (r < 0.95) return 6 + Math.floor(Math.random() * 7);   // 15% → 6~12 字
    return 15 + Math.floor(Math.random() * 26);               // 5%  → 15~40 字（偶发 burst）
  }

  // ===== chunk 到达间隔 =====
  // realistic：基础间隔更小(模拟快吐)，但按概率插入 300~1200ms 长停顿（模拟思考/调工具/网络）
  function nextDelayMs(): { delay: number; stall: boolean } {
    if (cfg.producerMode === 'smooth') {
      const base = cfg.producerDelayMs;
      const delay = cfg.randomDelay ? base + Math.floor(Math.random() * base * 1.5) : base;
      return { delay: Math.max(0, delay), stall: false };
    }
    // realistic：偶发长停顿是卡顿的主因
    if (Math.random() < cfg.stallProbability) {
      const stall = 300 + Math.floor(Math.random() * 900); // 300~1200ms
      return { delay: stall, stall: true };
    }
    const base = Math.max(8, cfg.producerDelayMs);
    // 基础间隔本身也带较大抖动（真实 SSE 到达并不均匀）
    const delay = cfg.randomDelay
      ? Math.floor(base * (0.4 + Math.random() * 1.6)) // 0.4x ~ 2.0x
      : base;
    return { delay: Math.max(0, delay), stall: false };
  }

  // ===== 生产者：模拟后端把 delta 投递进缓冲区 =====
  function produceStep() {
    if (!state.isStreaming) return;
    if (state.isPaused) {
      produceTimer = setTimeout(produceStep, 60);
      return;
    }
    if (producedLen >= fullContent.length) {
      producerDone = true;
      return;
    }

    // 投递一个 chunk
    const chunk = nextChunkSize();
    producedLen = Math.min(producedLen + chunk, fullContent.length);
    state.bufferedChars = producedLen - consumedLen;

    // bypassBuffer：chunk 到达即上屏（不经消费者削峰，直接还原后端原始卡顿）
    if (cfg.bypassBuffer) {
      consumedLen = producedLen;
      state.content = fullContent.slice(0, consumedLen);
      state.outputChars = consumedLen;
      state.bufferedChars = 0;
      onUpdate && onUpdate();
    }

    if (producedLen >= fullContent.length) {
      producerDone = true;
      // bypass 模式下没有消费者收尾，这里直接结束
      if (cfg.bypassBuffer) finish();
      return;
    }

    // 安排下一个 chunk 到达（可能是一次长停顿）
    const { delay, stall } = nextDelayMs();
    state.stalling = stall;
    if (stall) onUpdate && onUpdate(); // 让 UI 能显示「停顿中」
    produceTimer = setTimeout(() => {
      state.stalling = false;
      produceStep();
    }, delay);
  }

  // ===== 消费者：匀速从缓冲区取字上屏（打字机） =====
  function consumeTickMs(): number {
    const cps = Math.max(1, cfg.cps);
    const per = Math.max(1, cfg.charsPerTick);
    // 每 tick 消费 per 个字符，要达到 cps，则 tick 间隔 = 1000 * per / cps
    return Math.max(8, Math.round((1000 * per) / cps));
  }

  function consumeStep() {
    if (!state.isStreaming) return;
    // bypass 模式不启用消费者（上屏由生产者直接完成）
    if (cfg.bypassBuffer) return;
    if (state.isPaused) {
      consumeTimer = setTimeout(consumeStep, 60);
      return;
    }

    const available = producedLen - consumedLen; // 缓冲区可消费量
    if (available > 0) {
      let take = Math.max(1, cfg.charsPerTick);
      // 追赶：缓冲积压越多，单帧多吃一点（仍受上限约束，保持平滑）
      if (cfg.catchUp && available > 40) {
        take += Math.floor(available / 60);
        take = Math.min(take, Math.max(4, cfg.charsPerTick * 4));
      }
      consumedLen = Math.min(consumedLen + take, producedLen, fullContent.length);
      state.content = fullContent.slice(0, consumedLen);
      state.outputChars = consumedLen;
      state.bufferedChars = producedLen - consumedLen;
      onUpdate && onUpdate();
    }

    // 结束判定
    if (producerDone && consumedLen >= fullContent.length) {
      finish();
      return;
    }

    // 缓冲空(后端还没来)：短等；否则按节奏
    const nextMs = available > 0 ? consumeTickMs() : 30;
    consumeTimer = setTimeout(consumeStep, nextMs);
  }

  function finish() {
    state.isStreaming = false;
    state.isPaused = false;
    state.bufferedChars = 0;
    state.stalling = false;
    clearTimers();
    onUpdate && onUpdate();
    onDone && onDone();
  }

  function clearTimers() {
    if (produceTimer) { clearTimeout(produceTimer); produceTimer = null; }
    if (consumeTimer) { clearTimeout(consumeTimer); consumeTimer = null; }
  }

  // 第一参数保留(思考过程)以兼容旧签名；当前 demo 只用正文
  function start(_thinking: string, content: string) {
    stop();
    fullContent = content || '';
    producedLen = 0;
    consumedLen = 0;
    producerDone = false;
    state.reasonContent = '';
    state.content = '';
    state.outputChars = 0;
    state.bufferedChars = 0;
    state.stalling = false;
    state.isStreaming = true;
    state.isPaused = false;
    state.isThinkingPhase = false;
    state.messageCount += 1;
    produceStep();
    consumeStep();
  }

  function pause() {
    state.isPaused = true;
  }

  function resume() {
    if (!state.isStreaming || !state.isPaused) return;
    state.isPaused = false;
  }

  function stop() {
    state.isStreaming = false;
    state.isPaused = false;
    state.bufferedChars = 0;
    state.stalling = false;
    clearTimers();
  }

  function reset() {
    stop();
    state.reasonContent = '';
    state.content = '';
    state.outputChars = 0;
    state.messageCount = 0;
    producedLen = 0;
    consumedLen = 0;
    onUpdate && onUpdate();
  }

  return { state, cfg, setCallbacks, start, pause, resume, stop, reset };
}

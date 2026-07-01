// useStreamSim.ts
// 流式打字机：生产者-消费者模型（参考 KM《万字长文丝滑流式输出》三级增量方案）。
//
// 核心思想：把「后端产出」与「前端上屏」解耦。
//   生产者(模拟后端 SSE)：把目标文本按随机 chunk + 随机延迟投递进「缓冲区」；
//   消费者(前端打字机)：以稳定节奏，从缓冲区匀速取字上屏，形成逐字打字机效果。
// 这样：后端再快也不会大段上屏(逐字)，后端慢时消费端等待(不卡)，节奏由 cps 决定(可控)。

import { reactive } from 'vue';

export interface StreamConfig {
  cps: number;             // 打字速度：目标字/秒（消费速度，主控快慢）
  charsPerTick: number;    // 每帧最多消费字符数（1 最丝滑；调大更省但略跳）
  producerDelayMs: number; // 模拟后端分块到达间隔(ms)，体现缓冲区削峰
  randomDelay: boolean;    // 后端到达间隔加随机抖动（更贴近真实 SSE）
  catchUp: boolean;        // 缓冲积压时自动追赶（防长文拖太久，仍保持平滑）
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
  });

  const cfg = reactive<StreamConfig>({
    cps: 40,
    charsPerTick: 1,
    producerDelayMs: 50,
    randomDelay: true,
    catchUp: true,
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
    // 模拟一次 SSE delta：随机 3~12 字
    const chunk = 3 + Math.floor(Math.random() * 10);
    producedLen = Math.min(producedLen + chunk, fullContent.length);
    state.bufferedChars = producedLen - consumedLen;

    if (producedLen >= fullContent.length) {
      producerDone = true;
      return;
    }
    const base = cfg.producerDelayMs;
    const delay = cfg.randomDelay ? base + Math.floor(Math.random() * base * 1.5) : base;
    produceTimer = setTimeout(produceStep, Math.max(0, delay));
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

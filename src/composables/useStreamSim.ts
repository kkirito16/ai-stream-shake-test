// useStreamSim.ts
// 流式打字机：真实后端 SSE + 生产者-消费者模型。
//
// 数据源：真实后端服务（scripts/mock-stream-server.mjs 回放 SSE 报文）。
//   生产者：通过 sseClient 走真实网络流式接收，把 delta.content 追加进「缓冲区」；
//           后端的 chunk 粒度不均、思考/停顿期，都会如实反映到缓冲区的到达节奏上。
//   消费者：以稳定节奏(cps)从缓冲区匀速取字上屏，形成逐字打字机效果。
// 这样：后端再快也不会大段上屏(逐字)，后端慢时消费端等待(不卡)，节奏由 cps 决定(可控)。
//
// bypassBuffer：绕过 cps 匀速削峰，按帧快速逐字吐缓冲区——保留后端到达的
//   「忽快忽停」原始节奏（仍逐字），用于对比「原始卡顿 vs 缓冲削峰」。

import { reactive } from 'vue';
import { streamCompletions, type StreamHandle } from '@/helpers/sseClient';

export interface StreamConfig {
  serverUrl: string;       // 真实后端流式接口地址
  cps: number;             // 打字速度：目标字/秒（消费速度，主控快慢）
  charsPerTick: number;    // 每帧最多消费字符数（1 最丝滑；调大更省但略跳）
  catchUp: boolean;        // 缓冲积压时自动追赶（防长文拖太久，仍保持平滑）
  bypassBuffer: boolean;   // 绕过缓冲：不做 cps 匀速/削峰，按帧快速逐字吐缓冲区（呈现后端「忽快忽停」的原始节奏，但仍逐字）
}

export interface StreamState {
  reasonContent: string;   // 思考过程（reasoning_content 累积）
  content: string;         // 已上屏正文
  isStreaming: boolean;
  isPaused: boolean;
  isThinkingPhase: boolean; // 后端正在思考（只收到 reasoning、正文还没开始）
  outputChars: number;
  messageCount: number;
  bufferedChars: number;   // 缓冲区积压字符数（调试可视化）
  stalling: boolean;       // 后端停顿中（缓冲已空但流未结束 → 卡顿来源可视化）
  connecting: boolean;     // 正在连接后端
  errorMsg: string;        // 出错信息
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
    connecting: false,
    errorMsg: '',
  });

  const cfg = reactive<StreamConfig>({
    serverUrl: 'http://127.0.0.1:7788/v1/chat/completions',
    cps: 40,
    charsPerTick: 1,
    catchUp: true,
    bypassBuffer: false,
  });

  // 已到达缓冲区的全文（由 SSE delta.content 累积而成）
  let fullContent = '';
  // 消费者指针：已「上屏」的字符数
  let consumedLen = 0;
  // 生产者是否结束（SSE [DONE]/连接结束）
  let producerDone = false;
  // 最近一次收到正文 delta 的时间（用于判定停顿）
  let lastContentTs = 0;

  let consumeTimer: ReturnType<typeof setTimeout> | null = null;
  let handle: StreamHandle | null = null;

  let onUpdate: (() => void) | null = null;
  let onDone: (() => void) | null = null;

  function setCallbacks(update: () => void, done?: () => void) {
    onUpdate = update;
    onDone = done || null;
  }

  const STALL_MS = 160; // 缓冲空持续超过该时长，视为后端停顿

  // ===== 消费者：匀速从缓冲区取字上屏（打字机） =====
  function consumeTickMs(): number {
    const cps = Math.max(1, cfg.cps);
    const per = Math.max(1, cfg.charsPerTick);
    return Math.max(8, Math.round((1000 * per) / cps));
  }

  function consumeStep() {
    if (!state.isStreaming) return;
    if (state.isPaused) {
      consumeTimer = setTimeout(consumeStep, 60);
      return;
    }

    const producedLen = fullContent.length;
    const available = producedLen - consumedLen; // 缓冲区可消费量

    if (available > 0) {
      state.stalling = false;
      state.isThinkingPhase = false;
      let take = Math.max(1, cfg.charsPerTick);
      if (!cfg.bypassBuffer) {
        // 追赶：缓冲积压越多，单帧多吃一点（仍受上限约束，保持平滑）
        if (cfg.catchUp && available > 40) {
          take += Math.floor(available / 60);
          take = Math.min(take, Math.max(4, cfg.charsPerTick * 4));
        }
      }
      consumedLen = Math.min(consumedLen + take, producedLen);
      state.content = fullContent.slice(0, consumedLen);
      state.outputChars = consumedLen;
      state.bufferedChars = producedLen - consumedLen;
      onUpdate && onUpdate();
    } else {
      // 缓冲空：若流未结束且已等待较久，标记为「后端停顿中」
      const idleMs = Date.now() - lastContentTs;
      const shouldStall = !producerDone && idleMs > STALL_MS;
      if (shouldStall !== state.stalling) {
        state.stalling = shouldStall;
        onUpdate && onUpdate();
      }
    }

    // 结束判定：生产者结束且缓冲耗尽
    if (producerDone && consumedLen >= fullContent.length) {
      finish();
      return;
    }

    // bypass：缓冲有字用最小间隔尽快逐字；缓冲空时短等后端。
    // 普通：缓冲有字按 cps 节奏；缓冲空时短等。
    let nextMs: number;
    if (cfg.bypassBuffer) {
      nextMs = available > 0 ? 8 : 30;
    } else {
      nextMs = available > 0 ? consumeTickMs() : 30;
    }
    consumeTimer = setTimeout(consumeStep, nextMs);
  }

  function finish() {
    state.isStreaming = false;
    state.isPaused = false;
    state.bufferedChars = 0;
    state.stalling = false;
    state.isThinkingPhase = false;
    state.connecting = false;
    clearTimers();
    onUpdate && onUpdate();
    onDone && onDone();
  }

  function clearTimers() {
    if (consumeTimer) { clearTimeout(consumeTimer); consumeTimer = null; }
  }

  // 发起一次真实后端流式请求。question 作为请求体传给后端（mock 会忽略并回放报文）。
  function start(question: string) {
    stop();
    fullContent = '';
    consumedLen = 0;
    producerDone = false;
    lastContentTs = Date.now();
    state.reasonContent = '';
    state.content = '';
    state.outputChars = 0;
    state.bufferedChars = 0;
    state.stalling = false;
    state.errorMsg = '';
    state.isStreaming = true;
    state.isPaused = false;
    state.isThinkingPhase = true; // 连接后先进入思考态，直到第一个正文 delta
    state.connecting = true;
    state.messageCount += 1;

    handle = streamCompletions({
      url: cfg.serverUrl,
      body: { messages: [{ role: 'user', content: question || '' }], stream: true },
      onDelta: (delta) => {
        state.connecting = false;
        if (delta.reasoningContent) {
          state.reasonContent += delta.reasoningContent;
        }
        if (delta.content) {
          fullContent += delta.content;
          lastContentTs = Date.now();
        }
      },
      onDone: () => {
        producerDone = true;
      },
      onError: (err) => {
        producerDone = true;
        state.connecting = false;
        state.errorMsg = (err && (err as any).message) ? (err as any).message
          : '连接后端失败，请确认已运行 npm run mock 并检查地址';
        onUpdate && onUpdate();
      },
    });

    consumeStep();
  }

  function pause() { state.isPaused = true; }
  function resume() {
    if (!state.isStreaming || !state.isPaused) return;
    state.isPaused = false;
  }

  function stop() {
    state.isStreaming = false;
    state.isPaused = false;
    state.bufferedChars = 0;
    state.stalling = false;
    state.connecting = false;
    clearTimers();
    if (handle) { try { handle.abort(); } catch (e) {} handle = null; }
  }

  function reset() {
    stop();
    state.reasonContent = '';
    state.content = '';
    state.outputChars = 0;
    state.messageCount = 0;
    state.errorMsg = '';
    fullContent = '';
    consumedLen = 0;
    onUpdate && onUpdate();
  }

  return { state, cfg, setCallbacks, start, pause, resume, stop, reset };
}

// useStreamSim.ts
// 模拟后端 SSE 流式吐字 + 前端节流刷新，复刻真实项目 base.ts / cxtAgent.ts 的 doing() 逻辑。
// 真实链路：后端 delta 分块 -> content 累积 -> 80ms 节流(仅小程序) -> 每帧触发 UI 更新 + 滚动。

import { reactive, ref } from 'vue';

export interface StreamConfig {
  speedMs: number;        // 每次吐字间隔（对应「输出速度」）
  charsPerTick: number;   // 每次吐出字符数（对应「每次输出字符数」）
  randomDelay: boolean;   // 模拟随机延迟（后端抖动）
  throttleMs: number;     // 前端节流窗口（对应真实项目 80ms），0 = 不节流
}

export interface StreamState {
  reasonContent: string;  // 已输出的思考过程
  content: string;        // 已输出的正文
  isStreaming: boolean;
  isPaused: boolean;
  isThinkingPhase: boolean;
  outputChars: number;    // 已输出字数
  messageCount: number;   // 消息数
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
  });

  // 完整的目标文本（分思考/正文两段）
  let fullThinking = '';
  let fullContent = '';
  let thinkingIndex = 0;
  let contentIndex = 0;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;

  const cfg = reactive<StreamConfig>({
    speedMs: 1,
    charsPerTick: 1,
    randomDelay: false,
    throttleMs: 80,
  });

  // UI 层订阅：每次「需要刷新 UI」时回调（已考虑节流）
  let onUpdate: (() => void) | null = null;
  let onDone: (() => void) | null = null;

  function setCallbacks(update: () => void, done?: () => void) {
    onUpdate = update;
    onDone = done || null;
  }

  // 复刻真实项目的节流刷新：内容持续累积，但 UI 刷新受 throttleMs 限制
  function scheduleUpdate() {
    if (cfg.throttleMs <= 0) {
      onUpdate && onUpdate();
      return;
    }
    if (!throttleTimer) {
      throttleTimer = setTimeout(() => {
        throttleTimer && clearTimeout(throttleTimer);
        throttleTimer = null;
      }, cfg.throttleMs);
      onUpdate && onUpdate();
    }
    // 节流窗口内：内容已累积进 state，但不额外触发 UI 更新
  }

  function nextInterval(): number {
    if (!cfg.randomDelay) return cfg.speedMs;
    // 随机延迟：基础值 + 0~5 倍随机抖动，模拟真实后端网络/生成抖动
    return cfg.speedMs + Math.floor(Math.random() * cfg.speedMs * 5);
  }

  function tick() {
    if (state.isPaused || !state.isStreaming) return;

    // 先输出思考过程
    if (state.isThinkingPhase && thinkingIndex < fullThinking.length) {
      const end = Math.min(thinkingIndex + cfg.charsPerTick, fullThinking.length);
      state.reasonContent = fullThinking.slice(0, end);
      state.outputChars += end - thinkingIndex;
      thinkingIndex = end;
      scheduleUpdate();
      if (thinkingIndex >= fullThinking.length) {
        state.isThinkingPhase = false;
      }
      timer = setTimeout(tick, nextInterval());
      return;
    }

    // 再输出正文
    if (contentIndex < fullContent.length) {
      const end = Math.min(contentIndex + cfg.charsPerTick, fullContent.length);
      state.content = fullContent.slice(0, end);
      state.outputChars += end - contentIndex;
      contentIndex = end;
      scheduleUpdate();
      timer = setTimeout(tick, nextInterval());
      return;
    }

    // 结束
    finish();
  }

  function finish() {
    state.isStreaming = false;
    state.isPaused = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
    // 确保最终一帧完整刷新
    onUpdate && onUpdate();
    onDone && onDone();
  }

  function start(thinking: string, content: string) {
    stop();
    fullThinking = thinking || '';
    fullContent = content || '';
    thinkingIndex = 0;
    contentIndex = 0;
    state.reasonContent = '';
    state.content = '';
    state.outputChars = 0;
    state.isStreaming = true;
    state.isPaused = false;
    state.isThinkingPhase = !!fullThinking;
    state.messageCount += 1;
    tick();
  }

  function pause() {
    state.isPaused = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function resume() {
    if (!state.isStreaming || !state.isPaused) return;
    state.isPaused = false;
    tick();
  }

  // 单步输出（暂停状态下手动吐一批字）
  function step() {
    if (!state.isPaused && state.isStreaming) return;
    const wasStreaming = state.isStreaming;
    state.isStreaming = true;
    const savedPaused = state.isPaused;
    state.isPaused = false;

    if (state.isThinkingPhase && thinkingIndex < fullThinking.length) {
      const end = Math.min(thinkingIndex + cfg.charsPerTick, fullThinking.length);
      state.reasonContent = fullThinking.slice(0, end);
      state.outputChars += end - thinkingIndex;
      thinkingIndex = end;
      if (thinkingIndex >= fullThinking.length) state.isThinkingPhase = false;
    } else if (contentIndex < fullContent.length) {
      const end = Math.min(contentIndex + cfg.charsPerTick, fullContent.length);
      state.content = fullContent.slice(0, end);
      state.outputChars += end - contentIndex;
      contentIndex = end;
    }
    // 单步强制刷新 UI（绕过节流）
    onUpdate && onUpdate();

    state.isStreaming = wasStreaming;
    state.isPaused = savedPaused || wasStreaming;
    if (!wasStreaming) state.isStreaming = false;
    else state.isPaused = true;
  }

  function stop() {
    state.isStreaming = false;
    state.isPaused = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
  }

  function reset() {
    stop();
    state.reasonContent = '';
    state.content = '';
    state.outputChars = 0;
    state.messageCount = 0;
    thinkingIndex = 0;
    contentIndex = 0;
    onUpdate && onUpdate();
  }

  return { state, cfg, setCallbacks, start, pause, resume, step, stop, reset };
}

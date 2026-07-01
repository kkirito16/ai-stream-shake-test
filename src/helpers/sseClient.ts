// sseClient.ts
// 跨端 SSE 流式接收：连接真实后端的 `POST /v1/chat/completions`，
// 逐帧解析 `data: {...}` / `data: [DONE]`，回调 delta。
//   H5      -> fetch + ReadableStream
//   小程序   -> uni.request({ enableChunked:true }).onChunkReceived
// 统一策略：累积全部字节 → 全量 UTF-8 解码 → 按空行(\n\n)切完整帧解析，
// 天然规避「多字节字符/单帧被网络切断」的半包问题。

export interface SSEDelta {
  content?: string;
  reasoningContent?: string;
}

export interface StreamOptions {
  url: string;
  body?: unknown;
  onDelta: (delta: SSEDelta) => void;
  onDone: () => void;
  onError: (err: unknown) => void;
}

export interface StreamHandle {
  abort: () => void;
}

/** 全量 UTF-8 解码：优先原生 TextDecoder，缺失时手写兜底（对完整字节缓冲无半字符问题） */
function utf8Decode(bytes: Uint8Array): string {
  try {
    // @ts-ignore 部分小程序基础库/所有浏览器可用
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  } catch (e) { /* fallthrough */ }
  let out = '';
  let i = 0;
  const len = bytes.length;
  while (i < len) {
    const b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b >= 0xc0 && b < 0xe0) {
      const b1 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b & 0x1f) << 6) | b1);
    } else if (b >= 0xe0 && b < 0xf0) {
      const b1 = bytes[i++] & 0x3f;
      const b2 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b & 0x0f) << 12) | (b1 << 6) | b2);
    } else {
      const b1 = bytes[i++] & 0x3f;
      const b2 = bytes[i++] & 0x3f;
      const b3 = bytes[i++] & 0x3f;
      let cp = ((b & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3;
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

export function streamCompletions(opts: StreamOptions): StreamHandle {
  let aborted = false;
  let done = false;
  let acc = new Uint8Array(0);
  let lastFrameIdx = 0;

  function appendBytes(u8: Uint8Array) {
    const merged = new Uint8Array(acc.length + u8.length);
    merged.set(acc, 0);
    merged.set(u8, acc.length);
    acc = merged;
  }

  function finishOnce() {
    if (done) return;
    done = true;
    opts.onDone();
  }

  function handleFrame(frame: string) {
    // 一帧可能含多行，取以 data: 开头的行
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const bodyStr = line.slice(5).trim();
      if (!bodyStr) continue;
      if (bodyStr === '[DONE]') { finishOnce(); return; }
      try {
        const json: any = JSON.parse(bodyStr);
        const delta = (json && json.choices && json.choices[0] && json.choices[0].delta) || {};
        if (delta.content || delta.reasoning_content) {
          opts.onDelta({ content: delta.content, reasoningContent: delta.reasoning_content });
        }
        // role / tool_calls / tool_responses 等非正文字段：忽略
      } catch (e) {
        // 半包或非 JSON：忽略，等后续字节补齐
      }
    }
  }

  // 累积解码 + 按 \n\n 切完整帧。final=true 时把最后一段也当完整帧处理。
  function processAvailable(final: boolean) {
    const text = utf8Decode(acc);
    const frames = text.split('\n\n');
    const upto = final ? frames.length : frames.length - 1;
    for (let i = lastFrameIdx; i < upto; i++) {
      const frame = frames[i];
      if (frame && frame.trim()) handleFrame(frame);
      if (done) break;
    }
    if (upto > lastFrameIdx) lastFrameIdx = upto;
  }

  // #ifdef H5
  fetch(opts.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.body || {}),
  })
    .then(async (resp) => {
      if (!resp.ok || !resp.body) {
        opts.onError(new Error(`HTTP ${resp.status}`));
        return;
      }
      const reader = resp.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (aborted) { try { await reader.cancel(); } catch (e) {} break; }
        const { done: rdone, value } = await reader.read();
        if (rdone) { processAvailable(true); finishOnce(); break; }
        if (value) { appendBytes(value); processAvailable(false); }
      }
    })
    .catch((e) => { if (!aborted) opts.onError(e); });
  return { abort: () => { aborted = true; } };
  // #endif

  // #ifdef MP-WEIXIN
  const task = uni.request({
    url: opts.url,
    method: 'POST',
    header: { 'Content-Type': 'application/json' },
    data: (opts.body as any) || {},
    // @ts-ignore uni 类型未声明，但微信基础库支持分块传输
    enableChunked: true,
    responseType: 'text',
    success: () => {},
    fail: (e: unknown) => { if (!aborted) opts.onError(e); },
    complete: () => { processAvailable(true); finishOnce(); },
  });
  // @ts-ignore onChunkReceived 为分块接收回调
  if (task && typeof task.onChunkReceived === 'function') {
    // @ts-ignore
    task.onChunkReceived((res: { data: ArrayBuffer }) => {
      if (aborted || !res || !res.data) return;
      appendBytes(new Uint8Array(res.data));
      processAvailable(false);
    });
  }
  return {
    abort: () => {
      aborted = true;
      try { task && task.abort && task.abort(); } catch (e) {}
    },
  };
  // #endif
}

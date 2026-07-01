#!/usr/bin/env node
/**
 * 本地 Mock 流式 completions 服务（SSE 风格：`data: {...}` / `data: [DONE]`）。
 *
 * 用途：不再用「前端造 chunk」，而是启一个真实后端，把一份 SSE 报文文件
 *       按固定 interval 逐条 res.write 出去，让前端走真实网络流式接收，
 *       从而真实还原后端的 chunk 粒度不均 + 停顿期带来的卡顿。
 *
 * 路径：
 *   POST /v1/chat/completions   -> 回放 SSE 报文文件
 *   GET  /health                -> 健康检查
 *
 * 数据源（按优先级）：
 *   1. --file <path> 指定的文件
 *   2. src/mock/stream-real.text   （本地自备真实报文，已 gitignore，不进仓库）
 *   3. src/mock/stream-sample.text （脱敏示例，随仓库提交，人人可跑）
 *
 * 启动：
 *   node scripts/mock-stream-server.mjs
 *   node scripts/mock-stream-server.mjs --port 7788 --interval 80
 *   npm run mock            (interval 默认 60ms)
 *
 * 每条报文体原样使用，不做 JSON.parse——保持与真实后端字节一致。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const currentFilename = fileURLToPath(import.meta.url);
const currentDirname = path.dirname(currentFilename);
const projectRoot = path.resolve(currentDirname, '..');

const REAL_FILE = path.resolve(projectRoot, 'src/mock/stream-real.text');
const SAMPLE_FILE = path.resolve(projectRoot, 'src/mock/stream-sample.text');
const COMPLETIONS_PATH = '/v1/chat/completions';

function parseArgs(argv) {
  let port = Number(process.env.MOCK_STREAM_PORT) || 7788;
  let intervalMs = Number(process.env.MOCK_STREAM_INTERVAL_MS) || 60;
  let file = process.env.MOCK_STREAM_FILE || '';

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) {
      port = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--interval' && argv[i + 1]) {
      intervalMs = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--file' && argv[i + 1]) {
      file = argv[i + 1];
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(`用法: node scripts/mock-stream-server.mjs [--port 7788] [--interval 60] [--file <path>]

环境变量: MOCK_STREAM_PORT, MOCK_STREAM_INTERVAL_MS, MOCK_STREAM_FILE

路径:
  POST ${COMPLETIONS_PATH}   -> 回放 SSE 报文文件
  GET  /health               -> 健康检查

数据源优先级: --file > src/mock/stream-real.text > src/mock/stream-sample.text`);
      process.exit(0);
    }
  }
  return { port, intervalMs, file };
}

/** 选定数据源文件 */
function resolveDataFile(explicitFile) {
  if (explicitFile) {
    const p = path.isAbsolute(explicitFile) ? explicitFile : path.resolve(process.cwd(), explicitFile);
    if (fs.existsSync(p)) return p;
    console.warn(`[mock] 指定文件不存在，忽略: ${p}`);
  }
  if (fs.existsSync(REAL_FILE)) return REAL_FILE;
  return SAMPLE_FILE;
}

/**
 * 解析 SSE 报文文件 -> 每条报文体字符串数组。
 * 兼容 `data: {...}` 与 `data: [DONE]`；空行分隔。
 */
function loadChunks(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const chunks = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.startsWith('data:')) continue;
    const body = rawLine.slice(5).trim();
    if (!body) continue;
    chunks.push(body);
  }
  return chunks;
}

function sseLine(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `data: ${body}\n\n`;
}

function drainRequest(req) {
  return new Promise((resolve, reject) => {
    req.on('data', () => {});
    req.on('end', resolve);
    req.on('error', reject);
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Cookie, Authorization',
};

/** 按 interval 逐条投递 SSE 报文，末尾补 [DONE] */
function sendMockStream(res, chunks, intervalMs) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    ...CORS,
  });

  let index = 0;
  const timer = setInterval(() => {
    if (index < chunks.length) {
      try {
        res.write(sseLine(chunks[index]));
      } catch {
        clearInterval(timer);
        return;
      }
      index += 1;
      return;
    }
    try {
      const last = chunks[chunks.length - 1];
      if (last !== '[DONE]') res.write(sseLine('[DONE]'));
    } catch { /* ignore */ }
    clearInterval(timer);
    res.end();
  }, intervalMs);

  // 客户端断开则停止投递
  res.on('close', () => clearInterval(timer));
}

const { port, intervalMs, file } = parseArgs(process.argv);

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== 'POST' || pathname !== COMPLETIONS_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS });
    res.end(`Mock only serves POST ${COMPLETIONS_PATH} or GET /health\n`);
    return;
  }

  try {
    await drainRequest(req);
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }

  let chunks;
  try {
    const dataFile = resolveDataFile(file);
    chunks = loadChunks(dataFile);
  } catch (err) {
    console.error('[mock] 读取数据文件失败:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS });
    res.end(`Failed to read mock file: ${err.message}\n`);
    return;
  }

  sendMockStream(res, chunks, intervalMs);
});

/** 枚举本机局域网 IPv4 地址（供手机等同网段设备访问） */
function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

server.listen(port, '0.0.0.0', () => {
  const dataFile = resolveDataFile(file);
  const rel = path.relative(process.cwd(), dataFile);
  const usingReal = dataFile === REAL_FILE;
  const lanIPs = getLanIPs();
  const lanLines = lanIPs.length
    ? lanIPs.map((ip) => `  手机/局域网: http://${ip}:${port}${COMPLETIONS_PATH}`).join('\n')
    : '  (未检测到局域网 IP，请确认已连接 Wi-Fi/网线)';
  console.log(
    `[mock-stream-server] listening 0.0.0.0:${port}\n`
    + `  本机:        http://127.0.0.1:${port}${COMPLETIONS_PATH}\n`
    + `${lanLines}\n`
    + `  POST ${COMPLETIONS_PATH}\n`
    + `  数据源: ${rel} ${usingReal ? '(本地真实报文)' : '(脱敏示例)'}\n`
    + `  interval=${intervalMs}ms`,
  );
});

server.on('error', (err) => {
  console.error('[mock-stream-server]', err.message);
  process.exit(1);
});

# AI 流式消息抖动测试 (ai-stream-shake-test)

一个用于**复刻并优化 AI 问答中「打字机效果」流式渲染抖动**的测试工具。

技术栈与目标业务项目（`lct-ai`）保持一致：**uni-app + Vue 3 + TypeScript + Sass**，可编译到**微信小程序 (mp-weixin)** 与 **H5** 双端，从而在相同环境下真实复现小程序端的渲染抖动，并对比多种优化方案的效果。


---

## 一、背景：抖动从哪来？

对目标项目 AI 流式链路的调研结论：**并不存在传统的「逐字符队列打字机」**（无 per-char queue / setInterval 逐字吐出）。真实实现是：

```
后端 SSE delta 分块  →  content 全量累积  →  80ms 节流刷新(仅小程序)
        →  每次更新对「全量文本」重新 markdown-it 解析
        →  重建整棵自定义 token 树  →  原生 view/text 递归重渲染
        →  每帧 scrollToBottom
```

**打字机观感**来自后端自然分块 + 前端节流；而**抖动 (jitter)** 主要来自：

1. **每帧全量重解析**：`content` 越长，每帧 `md.parse` + 重建 token 树成本越大 → 掉帧/抖动。
2. **列表级整体重建**：每帧把整个消息数组浅拷贝替换，触发大范围响应式更新。
3. **markdown 半成品跳变**：流式中表格/列表/代码块结构在「未闭合 → 突然闭合」间跳变，导致布局跳动（如 `|` 尚未成表 → 突然成表）。
4. **v-for 用 index 作 key**：流式结构变化导致节点复用错乱。
5. **每帧滚动锚定**：每个 chunk 都触发 scroll，叠加 iOS WebView 的 scroll-anchoring 反向抖动。

---

## 二、这个 demo 做了什么

忠实复刻了上面整条链路（`markdownParser.ts` / `c-token-render.vue` / `useStreamSim.ts` 均对齐真实项目实现），并内置**多种渲染策略实时切换对比**：

| 策略 | 说明 |
| --- | --- |
| **Baseline 全量重解析** | 真实项目现状：每帧对全量文本重新解析 + 重建整棵 token 树。抖动最明显。 |
| **增量解析（仅末块）** | 按空行切块，缓存已稳定前缀，只重解析最后一个未闭合块。 |
| **稳定 Key** | 节点用稳定 key 替代 index，减少复用错乱导致的抖动。 |
| **rAF 帧对齐节流** | 多次内容变化合并到一帧渲染，避免同帧多次重排。 |

### 抖动量化指标

界面右下「调试信息」中的 **「高度变化次数」** 是核心抖动指标——通过 `boundingClientRect` 实时测量 AI 气泡高度，每变化一次计数一次。切换策略后重新输出同一段内容，即可直观对比各方案的抖动次数差异。此外还统计**重解析次数**与**耗时**。

---

## 三、界面说明（对齐参考设计）

- **左侧控制面板**：输出速度 (ms)、每次输出字符数、节流窗口 (ms)、渲染策略选择、思考过程/正文场景选择、模拟随机延迟、自动滚动、暂停/单步、突然插入大内容、调试信息。
- **中间输入区**：可编辑「思考过程」与「正文内容」，支持自定义 markdown 测试。
- **右侧聊天预览**：真实渲染 AI 回复气泡（含思考过程折叠区 + 正文 + 闪烁光标），流式输出中实时测量抖动。

---

## 四、运行

```bash
# 安装依赖
npm install

# H5 开发预览
npm run dev:h5

# 微信小程序开发（产物在 dist/dev/mp-weixin，用微信开发者工具打开）
npm run dev:mp-weixin

# 构建
npm run build:h5
npm run build:mp-weixin
```

> 微信小程序端才能真实复现小程序 WebView 的渲染抖动；H5 用于快速预览与逻辑验证。

---

## 五、目录结构

```
src/
├── components/
│   ├── c-markdown/          # markdown 渲染入口，按策略切换解析方式
│   ├── c-token-render/      # 递归渲染自定义 token 树（原生 view/text）
│   └── c-chat-bubble/       # AI 气泡 + 高度测量（抖动指标）
├── composables/
│   └── useStreamSim.ts      # 模拟 SSE 流式吐字 + 节流刷新（复刻 doing()）
├── helpers/
│   ├── markdownParser.ts    # markdown-it 全量解析 + token 树构建（移植自真实项目）
│   ├── incrementalParser.ts # 增量解析 + 稳定 key（优化策略）
│   └── mockContent.ts       # 测试场景（COS / 投研 / 代码块）
└── pages/index/index.vue    # 测试控制台主界面
```

---

## 六、优化方案建议（基于实测）

1. **增量解析替代全量重解析**（收益最大）：只对「最后一个未闭合块」解析，已稳定块缓存复用。
2. **rAF 帧对齐**：把 80ms 固定节流换成 `requestAnimationFrame` 对齐帧，或按 content 长度动态放宽节流窗口。
3. **只 patch 末条消息**：避免每帧重建整个消息数组。
4. **稳定 token key**：流式中保持节点 key 稳定，减少复用错乱。
5. **占位稳定**：对表格/代码块等结构，未闭合时用占位骨架，避免「突然成型」的布局跳变。

---

MIT License

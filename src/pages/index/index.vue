<script lang="ts">
import { defineComponent, ref, reactive, nextTick } from 'vue';
import { useStreamSim } from '@/composables/useStreamSim';

interface ChatMsg {
  id: string;
  role: 'user' | 'ai';
  content: string;
  streaming: boolean;
}

const DEFAULT_REPLY = `你好！我可以帮你分析这个问题。下面是我的建议：

### 一、核心思路

1. **先明确目标** —— 想清楚要**真正**解决什么。
2. 拆解步骤，把大问题拆成 *若干小块*。
3. 逐步验证，用 \`npm run build\` 每步都跑通。
4. 过期的 ~~旧方案~~ 直接淘汰，参考[官方文档](https://uniapp.dcloud.net.cn)。

### 二、示例代码

\`\`\`js
function hello(name) {
  return 'Hello, ' + name;
}
\`\`\`

希望这些对你有帮助，如需**更详细的方案**可以继续追问～`;

export default defineComponent({
  name: 'IndexPage',
  setup() {
    const sim = useStreamSim();
    const { state, cfg } = sim;

    // ===== 顶部安全区(状态栏 + 小程序胶囊按钮) =====
    const statusBarHeight = ref(0); // px
    const navRowHeight = ref(44); // px，导航内容行高
    const navRightGap = ref(24); // px，右侧给胶囊按钮留出的空隙
    try {
      const info: any = uni.getSystemInfoSync();
      statusBarHeight.value = info.statusBarHeight || 0;
      // #ifdef MP-WEIXIN
      const menu: any = uni.getMenuButtonBoundingClientRect();
      if (menu && menu.height) {
        // 让导航内容行与胶囊垂直居中对齐
        navRowHeight.value = (menu.top - statusBarHeight.value) * 2 + menu.height;
        // 内容右侧不越过胶囊左边缘
        navRightGap.value = (info.screenWidth || info.windowWidth) - menu.left + 8;
      }
      // #endif
    } catch (e) {}

    // ===== 设置 =====
    const replyText = ref(DEFAULT_REPLY);
    const settingsOpen = ref(true);
    // 流式消歧开关：消除 ** ` ~~ 链接等特殊符号在逐字流式中的闪现
    const sanitizeStream = ref(true);

    // ===== 对话 =====
    const messages = reactive<ChatMsg[]>([]);
    const inputText = ref('');
    const scrollIntoView = ref('');
    let aiSeq = 0;

    // 滚动节流：避免每帧都强制 scroll-into-view 造成的抖动/卡顿
    let lastScrollTs = 0;
    let scrollPending: ReturnType<typeof setTimeout> | null = null;
    function doScroll() {
      // 通过 toggle anchor 触发滚动（相同值不会重新滚动）
      scrollIntoView.value = '';
      nextTick(() => {
        scrollIntoView.value = 'chat-bottom';
      });
    }
    function scrollToBottom() {
      const now = Date.now();
      const gap = 120; // 最多每 120ms 滚动一次
      if (now - lastScrollTs >= gap) {
        lastScrollTs = now;
        doScroll();
      } else if (!scrollPending) {
        scrollPending = setTimeout(() => {
          scrollPending = null;
          lastScrollTs = Date.now();
          doScroll();
        }, gap - (now - lastScrollTs));
      }
    }

    // 流式更新时，把 sim 的正文同步到最后一条 AI 消息
    sim.setCallbacks(
      () => {
        const last = messages[messages.length - 1];
        if (last && last.role === 'ai') {
          last.content = state.content;
        }
        scrollToBottom();
      },
      () => {
        const last = messages[messages.length - 1];
        if (last && last.role === 'ai') {
          last.content = state.content;
          last.streaming = false;
        }
        // 结束时确保滚到底
        lastScrollTs = 0;
        scrollToBottom();
      }
    );

    function send() {
      const text = inputText.value.trim();
      if (!text) return;
      if (state.isStreaming) return; // 正在输出时不重复触发

      messages.push({ id: 'u' + Date.now(), role: 'user', content: text, streaming: false });
      inputText.value = '';

      // 新建一条空的 AI 消息，随后流式填充
      aiSeq += 1;
      messages.push({ id: 'a' + Date.now(), role: 'ai', content: '', streaming: true });

      scrollToBottom();
      // 只输出正文（无思考过程）
      sim.start('', replyText.value);
    }

    function clearChat() {
      sim.stop();
      messages.splice(0, messages.length);
    }

    function toggleSettings() {
      settingsOpen.value = !settingsOpen.value;
    }

    return {
      state, cfg,
      statusBarHeight, navRowHeight, navRightGap,
      replyText, settingsOpen, sanitizeStream,
      messages, inputText, scrollIntoView,
      send, clearChat, toggleSettings,
    };
  },
});
</script>

<template>
  <view class="page">
    <!-- 顶部标题（自定义导航栏，预留状态栏 + 胶囊安全区） -->
    <view class="topbar" :style="{ paddingTop: statusBarHeight + 'px' }">
      <view
        class="topbar-inner"
        :style="{ height: navRowHeight + 'px', paddingRight: navRightGap + 'px' }"
      >
        <text class="topbar-title">AI 流式回复测试</text>
        <text class="topbar-clear" @click="clearChat">清空</text>
      </view>
    </view>

    <!-- ===== 设置区 ===== -->
    <view class="settings">
      <view class="settings-head" @click="toggleSettings">
        <text class="settings-title">流式参数设置</text>
        <text class="settings-toggle">{{ settingsOpen ? '收起 ▲' : '展开 ▼' }}</text>
      </view>

      <view v-if="settingsOpen" class="settings-body">
        <view class="field-row">
          <view class="field">
            <text class="field-label">打字速度 (字/秒)</text>
            <input class="field-input" type="number" v-model.number="cfg.cps" />
          </view>
          <view class="field">
            <text class="field-label">每帧字符数</text>
            <input class="field-input" type="number" v-model.number="cfg.charsPerTick" />
          </view>
          <view class="field">
            <text class="field-label">后端到达间隔 (ms)</text>
            <input class="field-input" type="number" v-model.number="cfg.producerDelayMs" />
          </view>
        </view>

        <view class="switch-row">
          <view class="switch-item">
            <text class="switch-label">流式消歧(隐藏**符号)</text>
            <switch :checked="sanitizeStream" @change="(e:any)=>sanitizeStream=e.detail.value" color="#3a7afe" style="transform:scale(0.8)" />
          </view>
          <view class="switch-item">
            <text class="switch-label">后端随机抖动</text>
            <switch :checked="cfg.randomDelay" @change="(e:any)=>cfg.randomDelay=e.detail.value" color="#3a7afe" style="transform:scale(0.8)" />
          </view>
          <view class="switch-item">
            <text class="switch-label">积压自动追赶</text>
            <switch :checked="cfg.catchUp" @change="(e:any)=>cfg.catchUp=e.detail.value" color="#3a7afe" style="transform:scale(0.8)" />
          </view>
        </view>

        <view class="switch-row">
          <view class="switch-item buffer-tip">
            <text class="switch-label">缓冲积压</text>
            <text class="buffer-num">{{ state.bufferedChars }} 字</text>
          </view>
        </view>

        <view class="field field-full">
          <text class="field-label">模拟回复内容（发送后会流式返回这段内容）</text>
          <textarea class="field-textarea" v-model="replyText" :maxlength="-1" placeholder="输入 AI 要返回的内容，支持 Markdown..." />
        </view>
      </view>
    </view>

    <!-- ===== 对话区 ===== -->
    <scroll-view
      scroll-y
      class="chat"
      :scroll-into-view="scrollIntoView"
      :scroll-with-animation="false"
    >
      <view class="chat-inner">
        <view v-if="messages.length === 0" class="empty">
          <text class="empty-text">在下方输入任意内容并发送，AI 会流式返回你在上方设定的内容。</text>
        </view>

        <view v-for="msg in messages" :key="msg.id" class="msg-row" :class="msg.role">
          <!-- 用户 -->
          <view v-if="msg.role === 'user'" class="bubble user-bubble">
            <text>{{ msg.content }}</text>
          </view>
          <!-- AI -->
          <view v-else class="bubble ai-bubble">
            <c-markdown
              :content="msg.content"
              :show-cursor="msg.streaming"
              :sanitize-stream="sanitizeStream"
              strategy="incremental"
            />
          </view>
        </view>

        <view id="chat-bottom" class="bottom-anchor"></view>
      </view>
    </scroll-view>

    <!-- ===== 输入栏 ===== -->
    <view class="input-bar">
      <input
        class="input-box"
        v-model="inputText"
        :maxlength="-1"
        placeholder="输入消息..."
        confirm-type="send"
        @confirm="send"
      />
      <button class="send-btn" :disabled="state.isStreaming" @click="send">
        {{ state.isStreaming ? '输出中' : '发送' }}
      </button>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f2f3f5;
}

/* 顶部 */
.topbar {
  background: #fff;
  border-bottom: 1rpx solid #e5e6eb;
  flex-shrink: 0;
}
.topbar-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 32rpx;
}
.topbar-title {
  font-size: 32rpx;
  font-weight: 600;
  color: #1a1a1a;
}
.topbar-clear {
  font-size: 26rpx;
  color: #86909c;
}

/* 设置区 */
.settings {
  background: #fff;
  border-bottom: 1rpx solid #e5e6eb;
  flex-shrink: 0;
}
.settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20rpx 32rpx;
}
.settings-title {
  font-size: 28rpx;
  font-weight: 600;
  color: #1a1a1a;
  padding-left: 14rpx;
  border-left: 6rpx solid #3a7afe;
}
.settings-toggle {
  font-size: 24rpx;
  color: #3a7afe;
}
.settings-body {
  padding: 0 32rpx 24rpx;
}
.field-row {
  display: flex;
  flex-direction: row;
  gap: 16rpx;
  margin-bottom: 20rpx;
}
.switch-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 20rpx;
}
.switch-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  background: #f7f8fa;
  border-radius: 12rpx;
  padding: 10rpx 16rpx;
}
.switch-label {
  font-size: 22rpx;
  color: #86909c;
  margin-bottom: 4rpx;
}
.buffer-tip {
  align-items: flex-start;
}
.buffer-num {
  font-size: 28rpx;
  font-weight: 600;
  color: #3a7afe;
}
.field {
  flex: 1;
}
.field-full {
  width: 100%;
}
.field-label {
  display: block;
  font-size: 24rpx;
  color: #86909c;
  margin-bottom: 8rpx;
}
.field-input {
  width: 100%;
  height: 68rpx;
  line-height: 68rpx;
  background: #f2f3f5;
  border-radius: 12rpx;
  padding: 0 20rpx;
  font-size: 28rpx;
  color: #1a1a1a;
  box-sizing: border-box;
}
.field-textarea {
  width: 100%;
  min-height: 200rpx;
  background: #f2f3f5;
  border-radius: 12rpx;
  padding: 18rpx 20rpx;
  font-size: 26rpx;
  line-height: 1.6;
  color: #1a1a1a;
  box-sizing: border-box;
}

/* 对话区 */
.chat {
  flex: 1;
  height: 0;
}
.chat-inner {
  padding: 28rpx 24rpx 40rpx;
}
.empty {
  padding: 80rpx 40rpx;
  text-align: center;
}
.empty-text {
  font-size: 26rpx;
  color: #a9aeb8;
  line-height: 1.6;
}

.msg-row {
  display: flex;
  margin-bottom: 28rpx;
}
.msg-row.user {
  justify-content: flex-end;
}
.msg-row.ai {
  justify-content: flex-start;
}
.bubble {
  max-width: 78%;
  padding: 20rpx 24rpx;
  border-radius: 18rpx;
  font-size: 28rpx;
  line-height: 1.6;
  word-break: break-word;
}
.user-bubble {
  background: #3a7afe;
  color: #fff;
}
.ai-bubble {
  background: #fff;
  color: #1a1a1a;
  border: 1rpx solid #eef0f3;
}

.bottom-anchor {
  height: 2rpx;
}

/* 输入栏 */
.input-bar {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 16rpx;
  padding: 16rpx 24rpx;
  padding-bottom: calc(16rpx + constant(safe-area-inset-bottom));
  padding-bottom: calc(16rpx + env(safe-area-inset-bottom));
  background: #fff;
  border-top: 1rpx solid #e5e6eb;
  flex-shrink: 0;
}
.input-box {
  flex: 1;
  height: 76rpx;
  line-height: 76rpx;
  background: #f2f3f5;
  border-radius: 38rpx;
  padding: 0 28rpx;
  font-size: 28rpx;
  color: #1a1a1a;
}
.send-btn {
  width: 140rpx;
  height: 76rpx;
  line-height: 76rpx;
  background: #3a7afe;
  color: #fff;
  font-size: 28rpx;
  border-radius: 38rpx;
  padding: 0;
  margin: 0;
}
.send-btn::after { border: none; }
.send-btn[disabled] {
  background: #a9c4ff;
  color: #fff;
}
</style>

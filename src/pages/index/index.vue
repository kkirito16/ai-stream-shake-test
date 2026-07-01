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

1. **先明确目标** —— 想清楚要解决什么。
2. **拆解步骤** —— 把大问题拆成小块。
3. **逐步验证** —— 每一步都跑通再往下走。

### 二、示例代码

\`\`\`js
function hello(name) {
  return 'Hello, ' + name;
}
\`\`\`

希望这些对你有帮助，如需更详细的方案可以继续追问～`;

export default defineComponent({
  name: 'IndexPage',
  setup() {
    const sim = useStreamSim();
    const { state, cfg } = sim;

    // ===== 设置 =====
    const replyText = ref(DEFAULT_REPLY);
    const settingsOpen = ref(true);

    // ===== 对话 =====
    const messages = reactive<ChatMsg[]>([]);
    const inputText = ref('');
    const scrollIntoView = ref('');
    let aiSeq = 0;

    function scrollToBottom() {
      nextTick(() => {
        scrollIntoView.value = '';
        setTimeout(() => {
          scrollIntoView.value = 'chat-bottom';
        }, 0);
      });
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
      replyText, settingsOpen,
      messages, inputText, scrollIntoView,
      send, clearChat, toggleSettings,
    };
  },
});
</script>

<template>
  <view class="page">
    <!-- 顶部标题 -->
    <view class="topbar">
      <text class="topbar-title">AI 流式回复测试</text>
      <text class="topbar-clear" @click="clearChat">清空</text>
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
            <text class="field-label">输出速度 (ms)</text>
            <input class="field-input" type="number" v-model.number="cfg.speedMs" />
          </view>
          <view class="field">
            <text class="field-label">每次字符数</text>
            <input class="field-input" type="number" v-model.number="cfg.charsPerTick" />
          </view>
          <view class="field">
            <text class="field-label">刷新频率 (ms)</text>
            <input class="field-input" type="number" v-model.number="cfg.throttleMs" />
          </view>
        </view>

        <view class="field field-full">
          <text class="field-label">模拟回复内容（发送后会流式返回这段内容）</text>
          <textarea class="field-textarea" v-model="replyText" placeholder="输入 AI 要返回的内容，支持 Markdown..." />
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
              strategy="baseline"
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
  height: 88rpx;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 32rpx;
  background: #fff;
  border-bottom: 1rpx solid #e5e6eb;
  flex-shrink: 0;
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

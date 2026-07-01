<script lang="ts">
import { defineComponent, ref, reactive, nextTick, computed } from 'vue';
import { useStreamSim } from '@/composables/useStreamSim';

interface ChatMsg {
  id: string;
  role: 'user' | 'ai';
  content: string;
  streaming: boolean;
}

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
    const settingsOpen = ref(true);
    // 流式消歧开关：消除 ** ` ~~ 链接等特殊符号在逐字流式中的闪现
    const sanitizeStream = ref(true);
    // 是否展示后端思考过程(reasoning_content)
    const showReason = ref(false);

    // ===== 对话 =====
    const messages = reactive<ChatMsg[]>([]);
    const inputText = ref('');
    const scrollIntoView = ref('');
    let aiSeq = 0;

    // ===== 智能跟随（auto-follow）=====
    // 核心：只有当用户「贴着底部」时才自动跟随流式内容滚到底；
    // 一旦用户上滑查看历史，立即停止强制滚动，视口保持不动（符合阅读习惯）；
    // 用户滑回底部附近时自动恢复跟随。
    const autoFollow = ref(true); // 是否自动跟随到底部
    let lastScrollTop = 0; // 记录上次 scrollTop，用于判断滚动方向

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
      // 用户正在看历史（未贴底）时，绝不强制拉到底
      if (!autoFollow.value) return;
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

    // scroll-view 滚动回调：用户向上滑 → 关闭跟随；滑回底部由 onScrollToLower 恢复
    function onScroll(e: any) {
      const top = (e && e.detail && e.detail.scrollTop) || 0;
      // 向上滚动超过阈值，判定为用户主动查看历史，停止跟随
      if (top < lastScrollTop - 4) {
        autoFollow.value = false;
      }
      lastScrollTop = top;
    }
    // 滚到底部附近触发：恢复自动跟随
    function onScrollToLower() {
      autoFollow.value = true;
    }
    // 点击「回到底部」按钮：恢复跟随并立即滚到底
    function backToBottom() {
      autoFollow.value = true;
      lastScrollTs = 0;
      doScroll();
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

      // 新建一条空的 AI 消息，随后由真实后端流式填充
      aiSeq += 1;
      messages.push({ id: 'a' + Date.now(), role: 'ai', content: '', streaming: true });

      // 用户主动发问：强制恢复跟随并滚到底
      autoFollow.value = true;
      lastScrollTs = 0;
      scrollToBottom();
      // 走真实后端 SSE：把问题发给后端，回复内容来自后端报文文件
      sim.start(text);
    }

    function clearChat() {
      sim.stop();
      messages.splice(0, messages.length);
    }

    function toggleSettings() {
      settingsOpen.value = !settingsOpen.value;
    }

    const backendStatusText = computed(() => {
      if (state.errorMsg) return '连接失败';
      if (state.connecting) return '连接中…';
      if (state.stalling) return '停顿中…';
      if (state.isThinkingPhase && state.isStreaming) return '思考中…';
      if (state.isStreaming) return '推送中';
      return '空闲';
    });

    return {
      state, cfg,
      statusBarHeight, navRowHeight, navRightGap,
      settingsOpen, sanitizeStream, showReason,
      messages, inputText, scrollIntoView,
      backendStatusText,
      autoFollow,
      send, clearChat, toggleSettings,
      onScroll, onScrollToLower, backToBottom,
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
        <view class="field field-full">
          <text class="field-label">后端接口地址（先运行 npm run mock 启动本地服务）</text>
          <input class="field-input" type="text" v-model="cfg.serverUrl" placeholder="http://127.0.0.1:7788/v1/chat/completions" />
        </view>

        <view class="field-row">
          <view class="field">
            <text class="field-label">打字速度 (字/秒)</text>
            <input class="field-input" type="number" v-model.number="cfg.cps" />
          </view>
          <view class="field">
            <text class="field-label">每帧字符数</text>
            <input class="field-input" type="number" v-model.number="cfg.charsPerTick" />
          </view>
        </view>

        <view class="switch-row">
          <view class="switch-item">
            <view class="switch-head">
              <text class="switch-label">流式消歧</text>
              <switch :checked="sanitizeStream" @change="(e:any)=>sanitizeStream=e.detail.value" color="#3a7afe" style="transform:scale(0.72)" />
            </view>
            <text class="switch-hint">隐藏 ** 等标记</text>
          </view>
          <view class="switch-item">
            <view class="switch-head">
              <text class="switch-label">积压追赶</text>
              <switch :checked="cfg.catchUp" @change="(e:any)=>cfg.catchUp=e.detail.value" color="#3a7afe" style="transform:scale(0.72)" />
            </view>
            <text class="switch-hint">积压时加速</text>
          </view>
          <view class="switch-item">
            <view class="switch-head">
              <text class="switch-label">思考过程</text>
              <switch :checked="showReason" @change="(e:any)=>showReason=e.detail.value" color="#3a7afe" style="transform:scale(0.72)" />
            </view>
            <text class="switch-hint">展示推理内容</text>
          </view>
        </view>

        <view class="switch-row">
          <view class="switch-item">
            <view class="switch-head">
              <text class="switch-label">绕过缓冲</text>
              <switch :checked="cfg.bypassBuffer" @change="(e:any)=>cfg.bypassBuffer=e.detail.value" color="#f5222d" style="transform:scale(0.72)" />
            </view>
            <text class="switch-hint">还原原始卡顿</text>
          </view>
          <view class="switch-item stat-item">
            <text class="switch-label">缓冲积压</text>
            <text class="stat-num">{{ state.bufferedChars }} <text class="stat-unit">字</text></text>
          </view>
          <view class="switch-item stat-item">
            <text class="switch-label">后端状态</text>
            <text class="stat-num" :class="{ stalling: state.stalling || !!state.errorMsg }">{{ backendStatusText }}</text>
          </view>
        </view>

        <view v-if="state.errorMsg" class="err-tip">
          <text class="err-text">连接失败：{{ state.errorMsg }}</text>
        </view>
      </view>
    </view>

    <!-- ===== 对话区 ===== -->
    <scroll-view
      scroll-y
      class="chat"
      :scroll-into-view="scrollIntoView"
      :scroll-with-animation="false"
      :scroll-anchoring="true"
      :lower-threshold="40"
      @scroll="onScroll"
      @scrolltolower="onScrollToLower"
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
            <!-- 后端思考过程（可选展示） -->
            <view v-if="msg.streaming && showReason && state.reasonContent" class="reason-box">
              <text class="reason-title">思考过程</text>
              <text class="reason-text">{{ state.reasonContent }}</text>
            </view>
            <!-- 思考中占位：连接后到第一个正文 delta 之间 -->
            <view v-if="msg.streaming && !msg.content && (state.connecting || state.isThinkingPhase)" class="thinking">
              <text class="thinking-dot">●</text>
              <text class="thinking-text">{{ state.connecting ? '连接后端…' : '思考中…' }}</text>
            </view>
            <c-markdown
              v-if="msg.content"
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

    <!-- 「回到底部」悬浮按钮：用户上滑查看历史（未跟随）时显示 -->
    <view v-if="!autoFollow" class="to-bottom" @click="backToBottom">
      <text class="to-bottom-icon">↓</text>
      <text class="to-bottom-text">回到底部</text>
    </view>

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
  position: relative;
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
  align-items: stretch;
  gap: 16rpx;
  margin-bottom: 16rpx;
}
.switch-item {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: #f7f8fa;
  border: 1rpx solid #eef0f3;
  border-radius: 14rpx;
  padding: 16rpx 18rpx;
  box-sizing: border-box;
}
.switch-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 40rpx;
}
.switch-label {
  font-size: 25rpx;
  font-weight: 500;
  color: #1a1a1a;
  white-space: nowrap;
}
.switch-head .switch {
  margin-right: -8rpx;
}
.switch-hint {
  font-size: 20rpx;
  color: #a3a8b3;
  margin-top: 6rpx;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 统计类卡片（缓冲积压 / 后端状态） */
.stat-item {
  justify-content: center;
}
.stat-item .switch-label {
  color: #86909c;
  font-weight: 400;
  font-size: 22rpx;
  margin-bottom: 8rpx;
}
.stat-num {
  font-size: 30rpx;
  font-weight: 700;
  color: #3a7afe;
  line-height: 1.1;
}
.stat-unit {
  font-size: 22rpx;
  font-weight: 500;
  color: #86909c;
}
.stat-num.stalling {
  color: #f5222d;
}

/* 错误提示 */
.err-tip {
  margin-top: 4rpx;
  padding: 12rpx 16rpx;
  background: #fff1f0;
  border: 1rpx solid #ffccc7;
  border-radius: 12rpx;
}
.err-text {
  font-size: 22rpx;
  color: #f5222d;
  line-height: 1.5;
}

/* 思考中占位 */
.thinking {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10rpx;
}
.thinking-dot {
  font-size: 20rpx;
  color: #3a7afe;
  animation: blink 1s infinite;
}
.thinking-text {
  font-size: 26rpx;
  color: #86909c;
}
@keyframes blink {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

/* 思考过程 */
.reason-box {
  display: flex;
  flex-direction: column;
  margin-bottom: 16rpx;
  padding: 14rpx 18rpx;
  background: #f7f8fa;
  border-left: 4rpx solid #c9cdd4;
  border-radius: 8rpx;
}
.reason-title {
  font-size: 22rpx;
  color: #86909c;
  margin-bottom: 6rpx;
}
.reason-text {
  font-size: 24rpx;
  color: #6b7280;
  line-height: 1.6;
}

/* 分段选择器：后端投递模型 */
.seg-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20rpx;
}
.seg-title {
  font-size: 24rpx;
  color: #86909c;
}
.seg {
  display: flex;
  flex-direction: row;
  background: #f2f3f5;
  border-radius: 12rpx;
  padding: 4rpx;
}
.seg-btn {
  font-size: 24rpx;
  color: #86909c;
  padding: 8rpx 28rpx;
  border-radius: 10rpx;
}
.seg-btn.active {
  background: #fff;
  color: #3a7afe;
  font-weight: 600;
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

/* 「回到底部」悬浮按钮 */
.to-bottom {
  position: absolute;
  right: 24rpx;
  bottom: 140rpx;
  z-index: 20;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6rpx;
  padding: 12rpx 20rpx;
  background: #fff;
  border: 1rpx solid #e5e6eb;
  border-radius: 999rpx;
  box-shadow: 0 4rpx 16rpx rgba(0, 0, 0, 0.12);
}
.to-bottom-icon {
  font-size: 24rpx;
  color: #1677ff;
  line-height: 1;
}
.to-bottom-text {
  font-size: 24rpx;
  color: #1677ff;
  line-height: 1;
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

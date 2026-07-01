<script lang="ts">
import { defineComponent, ref, reactive, computed, watch, getCurrentInstance, nextTick } from 'vue';
import { useStreamSim } from '@/composables/useStreamSim';
import { SCENARIOS, THINKING_SAMPLES, getScenario } from '@/helpers/mockContent';
import type { RenderStrategy } from '@/components/c-markdown/c-markdown.vue';

interface StrategyOption {
  key: RenderStrategy;
  label: string;
  desc: string;
}

const STRATEGIES: StrategyOption[] = [
  { key: 'baseline', label: 'Baseline 全量重解析', desc: '每帧对全量文本重新 markdown 解析 + 重建整棵 token 树（真实项目现状，抖动最明显）' },
  { key: 'incremental', label: '增量解析（仅末块）', desc: '缓存已稳定前缀，只重解析最后一个未闭合块' },
  { key: 'stableKey', label: '稳定 Key', desc: '节点用稳定 key，减少 v-for index 复用错乱导致的抖动' },
  { key: 'raf', label: 'rAF 帧对齐节流', desc: '多次内容变化合并到一帧渲染，避免同帧多次重排' },
];

export default defineComponent({
  name: 'IndexPage',
  setup() {
    const instance = getCurrentInstance();
    const sim = useStreamSim();
    const { state, cfg } = sim;

    // ===== 左侧控制项 =====
    const thinkingKey = ref<'none' | 'short' | 'long'>('none');
    const scenarioKey = ref(SCENARIOS[0].key);
    const autoScroll = ref(true);
    const showThinking = ref(true);
    const strategy = ref<RenderStrategy>('baseline');

    // 思考过程 / 正文的可编辑文本
    const thinkingText = ref('');
    const contentText = ref(getScenario(SCENARIOS[0].key).content);

    watch(thinkingKey, (k) => {
      thinkingText.value = THINKING_SAMPLES[k].content;
    }, { immediate: true });

    watch(scenarioKey, (k) => {
      contentText.value = getScenario(k).content;
    });

    // ===== 抖动量化指标 =====
    const heightChanges = ref(0);
    const reparseCount = ref(0);
    const frameStart = ref(0);
    const elapsedMs = ref(0);

    function onHeightChange(payload: { changes: number }) {
      heightChanges.value = payload.changes;
    }
    function onReparse(count: number) {
      reparseCount.value = count;
    }

    // ===== 滚动 =====
    const scrollTop = ref(0);
    const scrollIntoView = ref('');

    function scrollToBottom() {
      if (!autoScroll.value) return;
      nextTick(() => {
        scrollIntoView.value = '';
        setTimeout(() => {
          scrollIntoView.value = 'chat-bottom-anchor';
        }, 0);
      });
    }

    // 绑定流式更新回调
    sim.setCallbacks(
      () => {
        // 每次 UI 刷新触发滚动（复刻真实项目每帧 scrollToBottom）
        scrollToBottom();
        if (frameStart.value) {
          elapsedMs.value = Date.now() - frameStart.value;
        }
      },
      () => {
        elapsedMs.value = frameStart.value ? Date.now() - frameStart.value : 0;
      }
    );

    // ===== 操作 =====
    function handleStart() {
      heightChanges.value = 0;
      reparseCount.value = 0;
      frameStart.value = Date.now();
      elapsedMs.value = 0;
      const tk = showThinking.value ? thinkingText.value : '';
      sim.start(tk, contentText.value);
    }

    function handlePause() {
      if (state.isPaused) {
        sim.resume();
      } else {
        sim.pause();
      }
    }

    function handleStep() {
      sim.step();
      scrollToBottom();
    }

    function handleStop() {
      sim.stop();
    }

    function handleReset() {
      sim.reset();
      heightChanges.value = 0;
      reparseCount.value = 0;
      elapsedMs.value = 0;
    }

    // 突然插入大段内容（模拟后端一次性吐出大 chunk，考验抖动）
    function handleInsertBig() {
      const big = '\n\n' + '这是一段突然插入的大段内容，用于模拟后端一次性返回长文本时的渲染压力。'.repeat(6);
      contentText.value += big;
      if (!state.isStreaming) {
        state.content += big;
      }
    }

    const statusText = computed(() => {
      if (state.isPaused) return '已暂停';
      if (state.isStreaming) return state.isThinkingPhase ? '思考中...' : '流式输出中...';
      return '空闲';
    });

    const currentStrategyDesc = computed(() => {
      return STRATEGIES.find(s => s.key === strategy.value)?.desc || '';
    });

    return {
      state, cfg,
      STRATEGIES, SCENARIOS, THINKING_SAMPLES,
      thinkingKey, scenarioKey, autoScroll, showThinking, strategy,
      thinkingText, contentText,
      heightChanges, reparseCount, elapsedMs,
      scrollTop, scrollIntoView,
      statusText, currentStrategyDesc,
      onHeightChange, onReparse,
      handleStart, handlePause, handleStep, handleStop, handleReset, handleInsertBig,
    };
  },
});
</script>

<template>
  <view class="page">
    <!-- 顶部标题栏 -->
    <view class="topbar">
      <text class="topbar-title">AI 流式消息抖动测试</text>
      <text class="topbar-tag">{{ STRATEGIES.find(s => s.key === strategy)?.label }}</text>
    </view>

    <view class="layout">
      <!-- ===== 左侧控制面板 ===== -->
      <scroll-view scroll-y class="panel panel-left">
        <view class="section-title">流式输出控制</view>

        <view class="form-item">
          <text class="form-label">输出速度 (ms)</text>
          <input class="form-input" type="number" v-model.number="cfg.speedMs" />
        </view>
        <view class="form-item">
          <text class="form-label">每次输出字符数</text>
          <input class="form-input" type="number" v-model.number="cfg.charsPerTick" />
        </view>
        <view class="form-item">
          <text class="form-label">节流窗口 (ms)</text>
          <input class="form-input" type="number" v-model.number="cfg.throttleMs" />
        </view>

        <view class="section-title">渲染策略（抖动优化对比）</view>
        <view class="strategy-list">
          <view
            v-for="opt in STRATEGIES"
            :key="opt.key"
            :class="['strategy-item', strategy === opt.key ? 'active' : '']"
            @click="strategy = opt.key"
          >
            <view class="strategy-radio">
              <view v-if="strategy === opt.key" class="strategy-dot"></view>
            </view>
            <view class="strategy-text">
              <text class="strategy-label">{{ opt.label }}</text>
              <text class="strategy-desc">{{ opt.desc }}</text>
            </view>
          </view>
        </view>

        <view class="section-title">测试场景</view>
        <view class="form-item">
          <text class="form-label">思考过程</text>
          <picker
            mode="selector"
            :range="Object.values(THINKING_SAMPLES).map(t => t.label)"
            @change="(e) => thinkingKey = Object.keys(THINKING_SAMPLES)[e.detail.value]"
          >
            <view class="form-picker">{{ THINKING_SAMPLES[thinkingKey].label }}</view>
          </picker>
        </view>
        <view class="form-item">
          <text class="form-label">正文内容</text>
          <picker
            mode="selector"
            :range="SCENARIOS.map(s => s.label)"
            @change="(e) => scenarioKey = SCENARIOS[e.detail.value].key"
          >
            <view class="form-picker">{{ SCENARIOS.find(s => s.key === scenarioKey)?.label }}</view>
          </picker>
        </view>

        <view class="checkbox-row" @click="cfg.randomDelay = !cfg.randomDelay">
          <view :class="['checkbox', cfg.randomDelay ? 'checked' : '']"></view>
          <text>模拟随机延迟</text>
        </view>
        <view class="checkbox-row" @click="autoScroll = !autoScroll">
          <view :class="['checkbox', autoScroll ? 'checked' : '']"></view>
          <text>自动滚动到底部</text>
        </view>
        <view class="checkbox-row" @click="showThinking = !showThinking">
          <view :class="['checkbox', showThinking ? 'checked' : '']"></view>
          <text>显示思考过程</text>
        </view>

        <view class="section-title">暂停控制</view>
        <view class="btn-row">
          <button class="btn btn-warn" @click="handlePause">
            {{ state.isPaused ? '继续输出' : '暂停输出' }}
          </button>
          <button class="btn btn-ghost" @click="handleStep">单步输出</button>
        </view>

        <view class="section-title">操作</view>
        <view class="btn-row">
          <button class="btn btn-primary" @click="handleStart">输出中...</button>
          <button class="btn btn-ghost" @click="handleStop">停止</button>
          <button class="btn btn-ghost" @click="handleReset">重置</button>
        </view>
        <view class="btn-row">
          <button class="btn btn-ghost" @click="handleInsertBig">突然插入大内容</button>
        </view>

        <view class="section-title">调试信息</view>
        <view class="debug-box">
          <view class="debug-row">
            <text class="debug-label">状态</text>
            <text class="debug-value">{{ statusText }}</text>
          </view>
          <view class="debug-row">
            <text class="debug-label">已输出字数</text>
            <text class="debug-value">{{ state.outputChars }}</text>
          </view>
          <view class="debug-row">
            <text class="debug-label">消息数</text>
            <text class="debug-value">{{ state.messageCount }}</text>
          </view>
          <view class="debug-row highlight">
            <text class="debug-label">高度变化次数（抖动）</text>
            <text class="debug-value shake">{{ heightChanges }}</text>
          </view>
          <view class="debug-row" v-if="strategy === 'incremental'">
            <text class="debug-label">重解析次数</text>
            <text class="debug-value">{{ reparseCount }}</text>
          </view>
          <view class="debug-row">
            <text class="debug-label">耗时 (ms)</text>
            <text class="debug-value">{{ elapsedMs }}</text>
          </view>
        </view>
      </scroll-view>

      <!-- ===== 中间输入区 ===== -->
      <scroll-view scroll-y class="panel panel-center">
        <view class="section-title">思考过程 (Thinking)</view>
        <textarea
          class="editor"
          v-model="thinkingText"
          placeholder="输入思考过程内容..."
        />
        <view class="section-title">正文内容 (Content)</view>
        <textarea
          class="editor editor-tall"
          v-model="contentText"
          placeholder="输入正文内容..."
        />
      </scroll-view>

      <!-- ===== 右侧聊天预览 ===== -->
      <view class="panel panel-right">
        <view class="chat-header">
          <text>聊天预览</text>
          <text class="chat-header-hint">{{ currentStrategyDesc }}</text>
        </view>
        <scroll-view
          scroll-y
          class="chat-scroll"
          :scroll-into-view="scrollIntoView"
          :scroll-with-animation="false"
        >
          <view class="chat-inner">
            <!-- 用户提问 -->
            <view class="user-msg">
              <view class="user-bubble">请帮我分析一下这个问题，并给出建议。</view>
            </view>

            <!-- AI 回复 -->
            <c-chat-bubble
              :msg-id="'msg-' + Date.now()"
              :msg-seq="state.messageCount"
              :reason-content="state.reasonContent"
              :content="state.content"
              :show-thinking="showThinking"
              :show-cursor="state.isStreaming && !state.isPaused"
              :strategy="strategy"
              @height-change="onHeightChange"
            />

            <view id="chat-bottom-anchor" class="bottom-anchor"></view>
          </view>
        </scroll-view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f7f8fa;
}

.topbar {
  height: 88rpx;
  display: flex;
  align-items: center;
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
.topbar-tag {
  margin-left: 20rpx;
  font-size: 22rpx;
  color: #3a7afe;
  background: #eef4ff;
  padding: 4rpx 16rpx;
  border-radius: 20rpx;
}

.layout {
  flex: 1;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

.panel {
  height: 100%;
  overflow: hidden;
}
.panel-left {
  width: 400rpx;
  background: #fff;
  border-right: 1rpx solid #e5e6eb;
  padding: 20rpx 24rpx;
}
.panel-center {
  width: 480rpx;
  background: #fbfbfc;
  border-right: 1rpx solid #e5e6eb;
  padding: 20rpx 24rpx;
}
.panel-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #f7f8fa;
}

.section-title {
  font-size: 26rpx;
  font-weight: 600;
  color: #4e5969;
  margin: 24rpx 0 14rpx;
  padding-left: 12rpx;
  border-left: 6rpx solid #3a7afe;
}

.form-item {
  margin-bottom: 16rpx;
}
.form-label {
  display: block;
  font-size: 24rpx;
  color: #86909c;
  margin-bottom: 8rpx;
}
.form-input, .form-picker {
  width: 100%;
  height: 64rpx;
  line-height: 64rpx;
  background: #f2f3f5;
  border-radius: 10rpx;
  padding: 0 20rpx;
  font-size: 26rpx;
  color: #1a1a1a;
  box-sizing: border-box;
}

.strategy-list {
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}
.strategy-item {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  padding: 14rpx 16rpx;
  border: 1rpx solid #e5e6eb;
  border-radius: 12rpx;
  background: #fff;
}
.strategy-item.active {
  border-color: #3a7afe;
  background: #f4f8ff;
}
.strategy-radio {
  width: 30rpx;
  height: 30rpx;
  border-radius: 50%;
  border: 2rpx solid #c9cdd4;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 14rpx;
  margin-top: 4rpx;
  flex-shrink: 0;
}
.strategy-item.active .strategy-radio {
  border-color: #3a7afe;
}
.strategy-dot {
  width: 16rpx;
  height: 16rpx;
  border-radius: 50%;
  background: #3a7afe;
}
.strategy-text {
  flex: 1;
}
.strategy-label {
  display: block;
  font-size: 25rpx;
  color: #1a1a1a;
  font-weight: 500;
}
.strategy-desc {
  display: block;
  font-size: 21rpx;
  color: #86909c;
  line-height: 1.4;
  margin-top: 4rpx;
}

.checkbox-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  margin: 14rpx 0;
  font-size: 25rpx;
  color: #4e5969;
}
.checkbox {
  width: 32rpx;
  height: 32rpx;
  border: 2rpx solid #c9cdd4;
  border-radius: 6rpx;
  margin-right: 14rpx;
  position: relative;
}
.checkbox.checked {
  background: #3a7afe;
  border-color: #3a7afe;
}
.checkbox.checked::after {
  content: '';
  position: absolute;
  left: 10rpx;
  top: 4rpx;
  width: 8rpx;
  height: 16rpx;
  border: solid #fff;
  border-width: 0 3rpx 3rpx 0;
  transform: rotate(45deg);
}

.btn-row {
  display: flex;
  flex-direction: row;
  gap: 12rpx;
  margin-bottom: 12rpx;
}
.btn {
  flex: 1;
  height: 64rpx;
  line-height: 64rpx;
  font-size: 24rpx;
  border-radius: 10rpx;
  padding: 0;
  margin: 0;
}
.btn::after { border: none; }
.btn-primary { background: #3a7afe; color: #fff; }
.btn-warn { background: #ffb020; color: #fff; }
.btn-ghost {
  background: #fff;
  color: #4e5969;
  border: 1rpx solid #c9cdd4;
}

.debug-box {
  background: #f7f8fa;
  border-radius: 12rpx;
  padding: 16rpx 20rpx;
}
.debug-row {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  padding: 8rpx 0;
  font-size: 24rpx;
}
.debug-row.highlight {
  border-top: 1rpx dashed #e5e6eb;
  margin-top: 6rpx;
  padding-top: 12rpx;
}
.debug-label { color: #86909c; }
.debug-value { color: #1a1a1a; font-weight: 500; }
.debug-value.shake { color: #f53f3f; font-size: 30rpx; }

.editor {
  width: 100%;
  min-height: 200rpx;
  background: #fff;
  border: 1rpx solid #e5e6eb;
  border-radius: 12rpx;
  padding: 20rpx;
  font-size: 25rpx;
  line-height: 1.6;
  color: #1a1a1a;
  box-sizing: border-box;
}
.editor-tall {
  min-height: 500rpx;
}

.chat-header {
  height: 72rpx;
  display: flex;
  align-items: center;
  padding: 0 28rpx;
  background: #fff;
  border-bottom: 1rpx solid #e5e6eb;
  font-size: 26rpx;
  font-weight: 600;
  color: #1a1a1a;
  flex-shrink: 0;
}
.chat-header-hint {
  margin-left: 16rpx;
  font-size: 20rpx;
  font-weight: 400;
  color: #86909c;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.chat-scroll {
  flex: 1;
  height: 0;
}
.chat-inner {
  padding: 28rpx 32rpx 60rpx;
}

.user-msg {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 24rpx;
}
.user-bubble {
  max-width: 70%;
  background: #d3e3fd;
  color: #1a1a1a;
  padding: 18rpx 24rpx;
  border-radius: 16rpx;
  font-size: 27rpx;
  line-height: 1.5;
}

.bottom-anchor {
  height: 2rpx;
}
</style>

<script lang="ts">
import { defineComponent, ref, watch, getCurrentInstance, PropType } from 'vue';
import type { RenderStrategy } from '@/components/c-markdown/c-markdown.vue';

// AI 回复气泡：渲染思考过程 + 正文，并测量自身高度变化次数（抖动量化指标）。
export default defineComponent({
  name: 'c-chat-bubble',
  props: {
    msgId: { type: String, default: '' },
    msgSeq: { type: Number, default: 0 },
    reasonContent: { type: String, default: '' },
    content: { type: String, default: '' },
    showThinking: { type: Boolean, default: true },
    showCursor: { type: Boolean, default: false },
    strategy: { type: String as PropType<RenderStrategy>, default: 'baseline' },
  },
  emits: ['height-change'],
  setup(props, { emit }) {
    const instance = getCurrentInstance();
    const lastHeight = ref(0);
    const heightChanges = ref(0);
    let measuring = false;

    // 测量气泡高度，若与上次不同则计一次「抖动」
    function measure() {
      if (measuring) return;
      measuring = true;
      const query = uni.createSelectorQuery().in(instance);
      query.select('.bubble-measure').boundingClientRect((rect: any) => {
        measuring = false;
        if (!rect) return;
        const h = Math.round(rect.height || 0);
        if (lastHeight.value !== 0 && h !== lastHeight.value) {
          heightChanges.value += 1;
          emit('height-change', { height: h, changes: heightChanges.value });
        }
        lastHeight.value = h;
      }).exec();
    }

    function resetMeasure() {
      lastHeight.value = 0;
      heightChanges.value = 0;
    }

    watch(
      () => [props.content, props.reasonContent],
      () => {
        // 内容变化后下一帧测量高度
        setTimeout(measure, 0);
      }
    );

    return { heightChanges, resetMeasure };
  },
});
</script>

<template>
  <view class="chat-bubble">
    <!-- 用户消息标签 -->
    <view class="msg-meta user-meta">
      msgId: {{ msgId }}, msgSeq: {{ msgSeq }}
    </view>

    <view class="bubble-measure">
      <!-- 思考过程 -->
      <view v-if="showThinking && reasonContent" class="thinking-box">
        <view class="thinking-title">
          <text class="thinking-icon">💭</text>
          <text>思考过程</text>
        </view>
        <view class="thinking-content">
          <c-markdown :content="reasonContent" :strategy="strategy" />
        </view>
      </view>

      <!-- 正文 -->
      <view v-if="content" class="content-box">
        <c-markdown :content="content" :show-cursor="showCursor" :strategy="strategy" />
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.chat-bubble {
  width: 100%;
}

.msg-meta {
  font-size: 22rpx;
  color: #86909c;
  background: #fff7e6;
  border: 1rpx solid #ffe4a3;
  border-radius: 8rpx;
  padding: 8rpx 14rpx;
  margin: 12rpx 0;
  word-break: break-all;
}

.thinking-box {
  background: #f7f8fa;
  border-radius: 12rpx;
  padding: 16rpx 20rpx;
  margin-bottom: 16rpx;
  border: 1rpx solid #eef0f3;
}
.thinking-title {
  display: flex;
  align-items: center;
  font-size: 24rpx;
  color: #86909c;
  margin-bottom: 8rpx;
}
.thinking-icon { margin-right: 6rpx; }
.thinking-content {
  font-size: 26rpx;
  color: #86909c;
}

.content-box {
  width: 100%;
}
</style>

<script lang="ts">
import { defineComponent, PropType } from 'vue';
import type { RenderNode } from '@/helpers/markdownParser';

// 递归渲染自定义 token 树，忠实复刻真实项目 c-token-render：
// 使用原生 view/text 逐节点渲染（非 rich-text / mp-html）。
export default defineComponent({
  name: 'c-token-render',
  props: {
    nodes: {
      type: Array as PropType<RenderNode[]>,
      default: () => [],
    },
    showCursor: {
      type: Boolean,
      default: false,
    },
    // 是否使用稳定 key（优化策略），否则用 index（baseline）
    stableKey: {
      type: Boolean,
      default: false,
    },
  },
  methods: {
    nodeKey(node: RenderNode, index: number): string {
      if (this.stableKey && node._k) return node._k;
      return String(index);
    },
    isLastTextNode(index: number): boolean {
      // 判断是否为末节点（用于挂光标）
      return index === this.nodes.length - 1;
    },
  },
});
</script>

<template>
  <view class="token-render">
    <block v-for="(node, index) in nodes" :key="nodeKey(node, index)">
      <!-- 标题 h1-h6 -->
      <view
        v-if="node.tag && /^h[1-6]$/.test(node.tag)"
        :class="['md-heading', 'md-' + node.tag]"
      >
        <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
      </view>

      <!-- 段落 -->
      <view v-else-if="node.tag === 'p'" class="md-p">
        <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
        <text
          v-if="showCursor && isLastTextNode(index)"
          class="cursor"
        ></text>
      </view>

      <!-- 无序列表 -->
      <view v-else-if="node.tag === 'ul'" class="md-ul">
        <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
      </view>

      <!-- 有序列表 -->
      <view v-else-if="node.tag === 'ol'" class="md-ol">
        <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
      </view>

      <!-- 列表项 -->
      <view v-else-if="node.tag === 'li'" class="md-li">
        <text class="md-li-dot">•</text>
        <view class="md-li-body">
          <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
        </view>
      </view>

      <!-- 引用 -->
      <view v-else-if="node.tag === 'blockquote'" class="md-quote">
        <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
      </view>

      <!-- 表格 -->
      <view v-else-if="node.tag === 'table'" class="md-table">
        <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
      </view>
      <view v-else-if="node.tag === 'thead'" class="md-thead">
        <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
      </view>
      <view v-else-if="node.tag === 'tbody'" class="md-tbody">
        <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
      </view>
      <view v-else-if="node.tag === 'tr'" class="md-tr">
        <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
      </view>
      <view v-else-if="node.tag === 'th'" class="md-th">
        <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
      </view>
      <view v-else-if="node.tag === 'td'" class="md-td">
        <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
      </view>

      <!-- 加粗 -->
      <text v-else-if="node.tag === 'strong'" class="md-strong">
        <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
      </text>

      <!-- 斜体 -->
      <text v-else-if="node.tag === 'em'" class="md-em">
        <c-token-render :nodes="node.children || []" :stable-key="stableKey" />
      </text>

      <!-- 代码块 -->
      <view v-else-if="node.tag === 'fence'" class="md-fence">
        <view class="md-fence-lang" v-if="node.info">{{ node.info }}</view>
        <text class="md-fence-code">{{ node.content }}</text>
      </view>

      <!-- 分隔线 -->
      <view v-else-if="node.tag === 'hr'" class="md-hr"></view>

      <!-- 行内代码 -->
      <text v-else-if="node.type === 'code_inline'" class="md-code-inline">{{ node.content }}</text>

      <!-- 链接 -->
      <text v-else-if="node.type === 'link'" class="md-link">{{ node.content }}</text>

      <!-- 图片 -->
      <image
        v-else-if="node.type === 'image'"
        class="md-img"
        :src="node.src"
        mode="widthFix"
      />

      <!-- 纯文本 -->
      <text v-else-if="node.type === 'text'" class="md-text">{{ node.content }}</text>
    </block>
  </view>
</template>

<style lang="scss" scoped>
.token-render {
  display: inline;
}

.md-heading {
  font-weight: 600;
  line-height: 1.5;
  margin: 16rpx 0 12rpx;
  color: #1a1a1a;
}
.md-h1 { font-size: 40rpx; }
.md-h2 { font-size: 36rpx; }
.md-h3 { font-size: 32rpx; }
.md-h4 { font-size: 30rpx; }

.md-p {
  font-size: 28rpx;
  line-height: 1.7;
  color: #1a1a1a;
  margin: 8rpx 0;
  word-break: break-word;
}

.md-ul, .md-ol {
  margin: 8rpx 0;
  padding-left: 8rpx;
}

.md-li {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  margin: 6rpx 0;
  line-height: 1.7;
}
.md-li-dot {
  color: #3a7afe;
  margin-right: 10rpx;
  flex-shrink: 0;
}
.md-li-body {
  flex: 1;
}

.md-quote {
  border-left: 6rpx solid #3a7afe;
  background: #f0f5ff;
  padding: 12rpx 20rpx;
  margin: 12rpx 0;
  color: #555;
  border-radius: 8rpx;
}

.md-table {
  display: flex;
  flex-direction: column;
  border: 1rpx solid #e5e6eb;
  border-radius: 8rpx;
  overflow: hidden;
  margin: 12rpx 0;
}
.md-thead { background: #f2f3f5; }
.md-tr {
  display: flex;
  flex-direction: row;
  border-bottom: 1rpx solid #e5e6eb;
}
.md-th, .md-td {
  flex: 1;
  padding: 12rpx 14rpx;
  font-size: 26rpx;
  line-height: 1.5;
  border-right: 1rpx solid #e5e6eb;
}
.md-th { font-weight: 600; color: #1a1a1a; }
.md-td { color: #333; }

.md-strong { font-weight: 600; color: #1a1a1a; }
.md-em { font-style: italic; }

.md-fence {
  background: #1e1e2e;
  border-radius: 12rpx;
  padding: 20rpx;
  margin: 12rpx 0;
  overflow-x: auto;
}
.md-fence-lang {
  font-size: 22rpx;
  color: #8b8ba7;
  margin-bottom: 8rpx;
}
.md-fence-code {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 24rpx;
  line-height: 1.6;
  color: #e0e0f0;
  white-space: pre;
}

.md-hr {
  height: 1rpx;
  background: #e5e6eb;
  margin: 20rpx 0;
}

.md-code-inline {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 25rpx;
  background: #f2f3f5;
  color: #d63384;
  padding: 2rpx 8rpx;
  border-radius: 6rpx;
}

.md-link { color: #3a7afe; }

.md-img {
  max-width: 100%;
  border-radius: 8rpx;
  margin: 8rpx 0;
}

.md-text {
  font-size: 28rpx;
  line-height: 1.7;
  color: #1a1a1a;
  white-space: pre-wrap;
  word-break: break-word;
}

.cursor {
  display: inline-block;
  width: 3rpx;
  height: 30rpx;
  background-color: #1a1a1a;
  margin-left: 2rpx;
  vertical-align: text-bottom;
  animation: blink 1s step-end infinite;
}
@keyframes blink {
  from, to { opacity: 1; }
  50% { opacity: 0; }
}
</style>

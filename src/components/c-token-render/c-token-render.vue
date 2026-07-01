<script lang="ts">
import { defineComponent, PropType, computed } from 'vue';
import type { RenderNode } from '@/helpers/markdownParser';

// 行内文本段：一段带样式标记的纯文本。
interface Seg {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: boolean;
  href?: string;
}
// 渲染单元：块级节点 / 行内文本段序列 / 图片。
type Unit =
  | { kind: 'block'; node: RenderNode }
  | { kind: 'text'; segs: Seg[] }
  | { kind: 'image'; src?: string; alt?: string };

const BLOCK_TAGS = new Set([
  'p', 'ul', 'ol', 'li', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'fence',
]);

function isBlockNode(node: RenderNode): boolean {
  if (!node.tag) return false;
  return BLOCK_TAGS.has(node.tag) || /^h[1-6]$/.test(node.tag);
}

// 把一个行内节点递归展开为带样式的文本段（strong/em 只影响样式，不产生嵌套结构）。
function inlineToSegs(node: RenderNode, style: { bold?: boolean; italic?: boolean }, out: Seg[]) {
  if (node.type === 'text') {
    out.push({ text: node.content || '', ...style });
  } else if (node.tag === 'strong') {
    (node.children || []).forEach(c => inlineToSegs(c, { ...style, bold: true }, out));
  } else if (node.tag === 'em') {
    (node.children || []).forEach(c => inlineToSegs(c, { ...style, italic: true }, out));
  } else if (node.type === 'code_inline') {
    out.push({ text: node.content || '', code: true, ...style });
  } else if (node.type === 'link') {
    out.push({ text: node.content || '', link: true, href: node.href, ...style });
  }
}

// 把一层 nodes 归并成渲染单元：连续的行内节点合并成一个 text 单元，
// 块级节点/图片各自独立。关键：行内内容全程扁平化为兄弟 <text>，
// 绝不在 <text> 内嵌套子组件（uni-text 会丢弃组件子节点，导致内容被吞）。
function buildUnits(nodes: RenderNode[]): Unit[] {
  const units: Unit[] = [];
  let buf: Seg[] = [];
  const flush = () => {
    if (buf.length) { units.push({ kind: 'text', segs: buf }); buf = []; }
  };
  for (const node of nodes) {
    if (isBlockNode(node)) {
      flush();
      units.push({ kind: 'block', node });
    } else if (node.type === 'image') {
      flush();
      units.push({ kind: 'image', src: node.src, alt: node.alt });
    } else {
      inlineToSegs(node, {}, buf);
    }
  }
  flush();
  return units;
}

// 递归渲染自定义 token 树。块级节点递归子组件（根为 view，安全）；
// 行内内容一律扁平化为带样式的 <text> 段，杜绝 <text> 内嵌组件被吞。
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
    // 逐字淡入动画：流式进行中开启，把文本段拆成单字并做一次性淡入；
    // 关闭时合并为整段文本（结束态/性能）。
    animate: {
      type: Boolean,
      default: false,
    },
  },
  setup(props) {
    const units = computed<Unit[]>(() => buildUnits(props.nodes || []));
    return { units };
  },
  methods: {
    unitKey(unit: Unit, index: number): string {
      if (this.stableKey && unit.kind === 'block' && unit.node._k) return unit.node._k;
      return `${unit.kind}-${index}`;
    },
    segClass(seg: Seg): string[] {
      const c: string[] = ['md-seg'];
      if (seg.bold) c.push('md-strong');
      if (seg.italic) c.push('md-em');
      if (seg.code) c.push('md-code-inline');
      if (seg.link) c.push('md-link');
      if (!seg.bold && !seg.italic && !seg.code && !seg.link) c.push('md-text');
      return c;
    },
    // 逐字模式：把一个文本单元的所有段拆成单字，key 用「单元内全局字序」保持稳定。
    // 稳定 key 让已上屏的字复用节点、不重播动画；只有新挂载的字触发一次淡入。
    unitChars(segs: Seg[]): Array<{ c: string; k: number; cls: string[] }> {
      const out: Array<{ c: string; k: number; cls: string[] }> = [];
      let idx = 0;
      for (const seg of segs) {
        const cls = this.segClass(seg);
        const text = seg.text || '';
        // 用 Array.from 以正确处理 emoji/代理对，避免半个字符
        for (const ch of Array.from(text)) {
          out.push({ c: ch, k: idx, cls });
          idx += 1;
        }
      }
      return out;
    },
    // 光标：挂在最后一个块级段落之后
    isLastCursorSpot(index: number): boolean {
      if (!this.showCursor) return false;
      const u = this.units[index];
      if (!u || u.kind !== 'block' || u.node.tag !== 'p') return false;
      // 之后没有其它块级/文本单元
      for (let k = index + 1; k < this.units.length; k++) {
        if (this.units[k].kind !== 'image') return false;
      }
      return true;
    },
  },
});
</script>

<template>
  <view class="token-render">
    <block v-for="(unit, index) in units" :key="unitKey(unit, index)">
      <!-- ===== 行内文本段：扁平的 <text> 兄弟，绝不嵌套子组件 ===== -->
      <text v-if="unit.kind === 'text'" class="md-inline">
        <!-- 逐字淡入模式：每个字一个 <text>，稳定 key 保证旧字不重播动画 -->
        <template v-if="animate">
          <text
            v-for="ch in unitChars(unit.segs)"
            :key="ch.k"
            :class="[...ch.cls, 'md-char']"
          >{{ ch.c }}</text>
        </template>
        <!-- 整段模式：按样式段渲染（结束态/性能） -->
        <template v-else>
          <text
            v-for="(seg, si) in unit.segs"
            :key="si"
            :class="segClass(seg)"
          >{{ seg.text }}</text>
        </template>
      </text>

      <!-- ===== 图片 ===== -->
      <image
        v-else-if="unit.kind === 'image'"
        class="md-img"
        :src="unit.src"
        mode="widthFix"
      />

      <!-- ===== 块级节点 ===== -->
      <template v-else>
        <!-- 标题 h1-h6 -->
        <view
          v-if="unit.node.tag && /^h[1-6]$/.test(unit.node.tag)"
          :class="['md-heading', 'md-' + unit.node.tag]"
        >
          <c-token-render :nodes="unit.node.children || []" :stable-key="stableKey" :animate="animate" />
        </view>

        <!-- 段落 -->
        <view v-else-if="unit.node.tag === 'p'" class="md-p">
          <c-token-render :nodes="unit.node.children || []" :stable-key="stableKey" :animate="animate" />
          <text v-if="isLastCursorSpot(index)" class="cursor"></text>
        </view>

        <!-- 无序列表 -->
        <view v-else-if="unit.node.tag === 'ul'" class="md-ul">
          <c-token-render :nodes="unit.node.children || []" :stable-key="stableKey" :animate="animate" />
        </view>

        <!-- 有序列表 -->
        <view v-else-if="unit.node.tag === 'ol'" class="md-ol">
          <c-token-render :nodes="unit.node.children || []" :stable-key="stableKey" :animate="animate" />
        </view>

        <!-- 列表项 -->
        <view v-else-if="unit.node.tag === 'li'" class="md-li">
          <text class="md-li-dot">•</text>
          <view class="md-li-body">
            <c-token-render :nodes="unit.node.children || []" :stable-key="stableKey" :animate="animate" />
          </view>
        </view>

        <!-- 引用 -->
        <view v-else-if="unit.node.tag === 'blockquote'" class="md-quote">
          <c-token-render :nodes="unit.node.children || []" :stable-key="stableKey" :animate="animate" />
        </view>

        <!-- 表格 -->
        <view v-else-if="unit.node.tag === 'table'" class="md-table">
          <c-token-render :nodes="unit.node.children || []" :stable-key="stableKey" :animate="animate" />
        </view>
        <view v-else-if="unit.node.tag === 'thead'" class="md-thead">
          <c-token-render :nodes="unit.node.children || []" :stable-key="stableKey" :animate="animate" />
        </view>
        <view v-else-if="unit.node.tag === 'tbody'" class="md-tbody">
          <c-token-render :nodes="unit.node.children || []" :stable-key="stableKey" :animate="animate" />
        </view>
        <view v-else-if="unit.node.tag === 'tr'" class="md-tr">
          <c-token-render :nodes="unit.node.children || []" :stable-key="stableKey" :animate="animate" />
        </view>
        <view v-else-if="unit.node.tag === 'th'" class="md-th">
          <c-token-render :nodes="unit.node.children || []" :stable-key="stableKey" :animate="animate" />
        </view>
        <view v-else-if="unit.node.tag === 'td'" class="md-td">
          <c-token-render :nodes="unit.node.children || []" :stable-key="stableKey" :animate="animate" />
        </view>

        <!-- 代码块 -->
        <view v-else-if="unit.node.tag === 'fence'" class="md-fence">
          <view class="md-fence-lang" v-if="unit.node.info">{{ unit.node.info }}</view>
          <text class="md-fence-code">{{ unit.node.content }}</text>
        </view>

        <!-- 分隔线 -->
        <view v-else-if="unit.node.tag === 'hr'" class="md-hr"></view>
      </template>
    </block>
  </view>
</template>

<style lang="scss" scoped>
.token-render {
  display: inline;
}

/* 行内文本容器：让内部各段 <text> 顺排 */
.md-inline {
  display: inline;
}
/* 行内段基类：保留换行/空格，随内容折行 */
.md-seg {
  font-size: 28rpx;
  line-height: 1.7;
  color: #1a1a1a;
  white-space: pre-wrap;
  word-break: break-word;
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

/* 逐字淡入：新挂载的字符播放一次淡入；已上屏字符因稳定 key 复用节点不重播。
   仅用 opacity（不含位移/transform），零布局抖动，两端一致。 */
.md-char {
  animation: char-in 0.28s ease-out both;
}
@keyframes char-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

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

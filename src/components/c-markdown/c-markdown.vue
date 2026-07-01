<script lang="ts">
import { defineComponent, ref, watch, PropType } from 'vue';
import { renderNodes, RenderNode } from '@/helpers/markdownParser';
import { createIncrementalParser, assignStableKeys } from '@/helpers/incrementalParser';
import { sanitizeStreamingMarkdown } from '@/helpers/streamMarkdownSanitizer';

export type RenderStrategy = 'baseline' | 'incremental' | 'stableKey' | 'raf';

// c-markdown：内容变化 -> 解析 -> 交给 c-token-render 渲染。
// 通过 strategy 切换不同优化方案，复刻并对比真实项目的抖动问题。
export default defineComponent({
  name: 'c-markdown',
  props: {
    content: { type: String, default: '' },
    showCursor: { type: Boolean, default: false },
    strategy: { type: String as PropType<RenderStrategy>, default: 'baseline' },
    // 流式消歧：解析前对末尾未闭合的行内标记(** * ` ~~ 链接)做处理，
    // 避免 `**`、`` ` `` 等特殊符号在逐字流式中闪现（详见 streamMarkdownSanitizer）。
    // 仅在 showCursor(流式中) 时生效；对已闭合文本恒等，不影响结束态。
    sanitizeStream: { type: Boolean, default: true },
  },
  emits: ['reparse'],
  setup(props, { emit }) {
    const nodes = ref<RenderNode[]>([]);
    const incParser = createIncrementalParser();
    let rafId: any = null;
    let pendingContent = '';

    function doRender(rawContent: string) {
      // 流式进行中做消歧，消除特殊符号闪现；结束或关闭时用原文。
      const content =
        props.sanitizeStream && props.showCursor
          ? sanitizeStreamingMarkdown(rawContent)
          : rawContent;
      let result: RenderNode[];
      if (props.strategy === 'incremental') {
        result = incParser.render(content);
        emit('reparse', incParser.getReparseCount());
      } else if (props.strategy === 'stableKey') {
        // 全量解析 + 稳定 key
        result = assignStableKeys(renderNodes(content));
      } else {
        // baseline / raf 都用全量解析（raf 只是把刷新对齐帧）
        result = renderNodes(content);
      }
      nodes.value = result;
    }

    watch(
      () => props.content,
      (newVal) => {
        if (props.strategy === 'raf') {
          // rAF 节流：多次 content 变化合并到一帧渲染
          pendingContent = newVal;
          if (rafId) return;
          const raf = typeof requestAnimationFrame !== 'undefined'
            ? requestAnimationFrame
            : (cb: any) => setTimeout(cb, 16);
          rafId = raf(() => {
            rafId = null;
            doRender(pendingContent);
          });
        } else {
          doRender(newVal);
        }
      },
      { immediate: true }
    );

    // 策略切换时重置增量缓存并重渲染
    watch(
      () => props.strategy,
      () => {
        incParser.reset();
        doRender(props.content);
      }
    );

    // 流式结束(showCursor:true→false)时，用原文再渲染一次，确保结束态为完整原文。
    watch(
      () => props.showCursor,
      () => {
        doRender(props.content);
      }
    );

    return { nodes };
  },
});
</script>

<template>
  <view class="c-markdown">
    <c-token-render
      :nodes="nodes"
      :show-cursor="showCursor"
      :stable-key="strategy === 'stableKey'"
    />
  </view>
</template>

<style lang="scss" scoped>
.c-markdown {
  width: 100%;
}
</style>

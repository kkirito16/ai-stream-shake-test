<script lang="ts">
import { defineComponent, ref, watch, PropType } from 'vue';
import { renderNodes, RenderNode } from '@/helpers/markdownParser';
import { createIncrementalParser, assignStableKeys } from '@/helpers/incrementalParser';

export type RenderStrategy = 'baseline' | 'incremental' | 'stableKey' | 'raf';

// c-markdown：内容变化 -> 解析 -> 交给 c-token-render 渲染。
// 通过 strategy 切换不同优化方案，复刻并对比真实项目的抖动问题。
export default defineComponent({
  name: 'c-markdown',
  props: {
    content: { type: String, default: '' },
    showCursor: { type: Boolean, default: false },
    strategy: { type: String as PropType<RenderStrategy>, default: 'baseline' },
  },
  emits: ['reparse'],
  setup(props, { emit }) {
    const nodes = ref<RenderNode[]>([]);
    const incParser = createIncrementalParser();
    let rafId: any = null;
    let pendingContent = '';

    function doRender(content: string) {
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

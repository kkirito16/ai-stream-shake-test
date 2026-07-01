// incrementalParser.ts
// 增量解析策略：把已经「稳定」的前缀块缓存下来，只对末尾「可能还在变化」的块重新解析。
// 核心思想：markdown 的块级结构以空行分隔。流式过程中，除最后一个块外，
// 前面的块基本已闭合稳定，可复用上一次的解析结果，避免全量重解析。

import { parseMarkdown, processSimpleTokens, RenderNode } from './markdownParser';

interface Cache {
  // 已稳定前缀的原文
  stableText: string;
  // 已稳定前缀解析出的节点
  stableNodes: RenderNode[];
  // 稳定块数量（按 \n\n 分割）
  stableBlockCount: number;
}

export function createIncrementalParser() {
  let cache: Cache = { stableText: '', stableNodes: [], stableBlockCount: 0 };
  let reparseCount = 0; // 统计实际重解析次数（用于量化）

  function reset() {
    cache = { stableText: '', stableNodes: [], stableBlockCount: 0 };
    reparseCount = 0;
  }

  function getReparseCount() {
    return reparseCount;
  }

  /**
   * 增量渲染：只解析「最后一个未闭合块」。
   * 把 content 按空行切成块，认为前 n-1 个块已稳定，缓存其解析结果；
   * 只重新解析最后一块，然后拼接。
   */
  function render(content: string): RenderNode[] {
    if (!content) return [];

    // 按块级分隔符切分（保留分隔，便于精确重建）
    const blocks = content.split(/\n{2,}/);

    // 稳定块 = 除最后一块外的所有块
    const stableBlockCount = Math.max(0, blocks.length - 1);
    const stableText = blocks.slice(0, stableBlockCount).join('\n\n');
    const lastBlock = blocks[blocks.length - 1] || '';

    // 若稳定前缀与缓存一致，复用缓存的稳定节点，只解析最后一块
    if (stableBlockCount > 0 && stableText === cache.stableText) {
      // 命中缓存：只解析最后一块
      reparseCount += 1;
      const lastNodes = lastBlock ? processSimpleTokens(parseMarkdown(lastBlock)) : [];
      return cache.stableNodes.concat(lastNodes);
    }

    // 未命中（稳定块数量增加了）：重新解析稳定前缀并缓存
    reparseCount += 1;
    const stableNodes = stableText ? processSimpleTokens(parseMarkdown(stableText)) : [];
    cache = { stableText, stableNodes, stableBlockCount };

    const lastNodes = lastBlock ? processSimpleTokens(parseMarkdown(lastBlock)) : [];
    return stableNodes.concat(lastNodes);
  }

  return { render, reset, getReparseCount };
}

/**
 * 为节点树生成稳定 key：基于路径 + 类型 + 内容前缀。
 * 用于减少 v-for 用 index 作 key 导致的节点复用错乱。
 */
export function assignStableKeys(nodes: RenderNode[], prefix = 'n'): RenderNode[] {
  nodes.forEach((node, i) => {
    const sig = node.tag || node.type || 'x';
    node._k = `${prefix}-${i}-${sig}`;
    if (node.children && node.children.length) {
      assignStableKeys(node.children, node._k);
    }
  });
  return nodes;
}

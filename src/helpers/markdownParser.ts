// markdownParser.ts
// 忠实移植自真实项目 lct-models/ai/helpers/markdown/markdownParser.ts
// 关键点：每次流式更新都对「全量文本」重新走 markdown-it 解析 + 重建自定义 token 树，
// 这是真机抖动的主要来源之一，demo 中作为 baseline 策略完整复刻。

import MarkdownIt from 'markdown-it';

export interface RenderNode {
  type?: string;
  tag?: string;
  content?: string;
  children?: RenderNode[];
  attrs?: Record<string, string>;
  hasNewline?: boolean;
  selfClosing?: boolean;
  href?: string;
  src?: string;
  alt?: string;
  info?: string;
  // 稳定 key 策略用：为节点分配的稳定标识
  _k?: string;
}

let mdInstance: MarkdownIt | null = null;

function getMd(): MarkdownIt {
  if (!mdInstance) {
    mdInstance = new MarkdownIt({
      html: true,
      linkify: true,
      typographer: false,
      breaks: true,
    });
    mdInstance.linkify.set({ fuzzyLink: false });
  }
  return mdInstance;
}

/**
 * 全量解析：对整段 content 走 markdown-it，返回原始 token 数组。
 * 对应真实项目 renderTokens。
 */
export function parseMarkdown(content: string): any[] {
  return getMd().parse(content, {});
}

// 处理 inline 子内容（移植自真实项目 processInlineTokens）
function processInlineTokens(children: any[]): RenderNode[] {
  const result: RenderNode[] = [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    if (child.type === 'text') {
      if (child.content) {
        result.push({
          type: 'text',
          content: child.content,
          hasNewline: child.content.includes('\n'),
        });
      }
    } else if (child.type === 'strong_open') {
      let j = i + 1;
      const strongChildren: any[] = [];
      while (j < children.length && children[j].type !== 'strong_close') {
        strongChildren.push(children[j]);
        j += 1;
      }
      const processed = processInlineTokens(strongChildren);
      result.push({
        tag: 'strong',
        children: processed.length > 0 ? processed : [{ type: 'text', content: '' }],
      });
      i = j;
    } else if (child.type === 'em_open') {
      let j = i + 1;
      const emChildren: any[] = [];
      while (j < children.length && children[j].type !== 'em_close') {
        emChildren.push(children[j]);
        j += 1;
      }
      const processed = processInlineTokens(emChildren);
      result.push({
        tag: 'em',
        children: processed.length > 0 ? processed : [{ type: 'text', content: '' }],
      });
      i = j;
    } else if (child.type === 'link_open') {
      let linkText = '';
      const linkHref = child?.attrs?.[0]?.[1] || '';
      let j = i + 1;
      while (j < children.length && children[j].type !== 'link_close') {
        if (children[j].type === 'text') {
          linkText += children[j].content;
        }
        j += 1;
      }
      result.push({ type: 'link', content: linkText, href: linkHref });
      i = j;
    } else if (child.type === 'image') {
      const attrs = child.attrs || [];
      const src = attrs.find((a: any) => a[0] === 'src')?.[1] || '';
      result.push({ type: 'image', src, alt: child.content || '' });
    } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
      if (result.length > 0 && result[result.length - 1].type === 'text') {
        result[result.length - 1].content += '\n';
        result[result.length - 1].hasNewline = true;
      } else {
        result.push({ type: 'text', content: '\n', hasNewline: true });
      }
    } else if (child.type === 'code_inline') {
      result.push({ type: 'code_inline', content: child.content });
    }
  }

  return result;
}

// 移植自真实项目 processSimpleTokens
export function processSimpleTokens(tokens: any[]): RenderNode[] {
  const result: RenderNode[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || !token.type) continue;

    if (token.type === 'inline' && token.children) {
      result.push(...processInlineTokens(token.children));
    } else if (token.type === 'text') {
      result.push({
        type: 'text',
        content: token.content,
        hasNewline: token.content && token.content.includes('\n'),
      });
    } else if (token.type === 'code_inline') {
      result.push({ type: 'code_inline', content: token.content });
    } else if (token.type === 'hr') {
      result.push({ tag: 'hr', selfClosing: true });
    } else if (token.type === 'fence') {
      result.push({ tag: 'fence', info: token.info, content: token.content });
    } else if (token.type.endsWith('_open')) {
      const element: RenderNode = { tag: token.tag, children: [], attrs: {} };
      if (token.attrs) {
        token.attrs.forEach(([key, value]: [string, string]) => {
          element.attrs![key] = value;
        });
      }
      const endType = token.type.replace('_open', '_close');
      let level = 1;
      let j = i + 1;
      const childrenTokens: any[] = [];
      while (j < tokens.length && level > 0) {
        const childToken = tokens[j];
        if (childToken.type === token.type) {
          level += 1;
        } else if (childToken.type === endType) {
          level -= 1;
          if (level === 0) break;
        }
        childrenTokens.push(childToken);
        j += 1;
      }
      if (childrenTokens.length > 0) {
        element.children = processSimpleTokens(childrenTokens);
      }
      result.push(element);
      i = j;
    }
  }

  return result;
}

/**
 * baseline 全量渲染：content -> token 树。每次调用都全量解析。
 */
export function renderNodes(content: string): RenderNode[] {
  const tokens = parseMarkdown(content);
  return processSimpleTokens(tokens);
}

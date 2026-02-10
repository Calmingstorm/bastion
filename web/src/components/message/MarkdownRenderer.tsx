import { useMemo } from 'react';
import MarkdownIt from 'markdown-it';
import type { Options } from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type Renderer from 'markdown-it/lib/renderer.mjs';
import hljs from 'highlight.js/lib/core';

// Register common languages
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import sql from 'highlight.js/lib/languages/sql';
import java from 'highlight.js/lib/languages/java';
import rust from 'highlight.js/lib/languages/rust';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('go', go);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('java', java);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang }).value}</code></pre>`;
      } catch { /* fallback */ }
    }
    // Auto-detect
    try {
      return `<pre class="hljs"><code>${hljs.highlightAuto(str).value}</code></pre>`;
    } catch { /* fallback */ }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

// Override link rendering to add target="_blank" rel="noopener noreferrer"
const defaultLinkOpen = md.renderer.rules.link_open || function(tokens: Token[], idx: number, options: Options, _env: unknown, self: Renderer) {
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.link_open = function(tokens: Token[], idx: number, options: Options, env: unknown, self: Renderer): string {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Spoiler tag inline rule: ||content||
md.inline.ruler.before('emphasis', 'spoiler', (state: StateInline, silent: boolean): boolean => {
  const start = state.pos;
  const marker = state.src.slice(start, start + 2);
  if (marker !== '||') return false;

  const end = state.src.indexOf('||', start + 2);
  if (end === -1) return false;

  if (!silent) {
    const token = state.push('spoiler_open', 'span', 1);
    token.attrSet('class', 'spoiler');
    token.attrSet('onclick', 'this.classList.toggle("spoiler-revealed")');
    token.markup = '||';

    const content = state.src.slice(start + 2, end);
    const textToken = state.push('text', '', 0);
    textToken.content = content;

    state.push('spoiler_close', 'span', -1);
  }

  state.pos = end + 2;
  return true;
});

// Mention inline rule: @username
md.inline.ruler.after('emphasis', 'mention', (state: StateInline, silent: boolean): boolean => {
  if (state.src.charCodeAt(state.pos) !== 0x40 /* @ */) return false;

  const match = state.src.slice(state.pos).match(/^@([a-zA-Z0-9_-]+)/);
  if (!match) return false;

  if (!silent) {
    const username = match[1];
    const isBastion = username.toLowerCase() === 'bastion';
    const token = state.push('mention_open', 'span', 1);
    token.attrSet('class', isBastion ? 'mention mention-bastion' : 'mention');
    token.markup = '@';

    const textToken = state.push('text', '', 0);
    textToken.content = `@${username}`;

    state.push('mention_close', 'span', -1);
  }

  state.pos += match[0].length;
  return true;
});

// Image/GIF embed core rule: detect standalone image URLs in paragraphs
const IMAGE_EXT_RE = /\.(gif|gifv|png|jpg|jpeg|webp)(\?[^\s]*)?$/i;
const GIF_CDN_HOSTS = ['media.tenor.com', 'media1.tenor.com', 'media2.tenor.com', 'media3.tenor.com', 'media4.tenor.com', 'i.giphy.com', 'media.giphy.com', 'media0.giphy.com', 'media1.giphy.com', 'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com', 'c.tenor.com'];

function isImageUrl(href: string): boolean {
  if (IMAGE_EXT_RE.test(href)) return true;
  try {
    const host = new URL(href).hostname;
    return GIF_CDN_HOSTS.includes(host);
  } catch { return false; }
}

md.core.ruler.after('inline', 'image_embed', (state: StateCore) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'inline') continue;
    const parent = tokens[i - 1];
    if (!parent || parent.type !== 'paragraph_open') continue;

    const children = tokens[i].children;
    if (!children) continue;

    // Check if inline contains exactly one link with no other text
    const linkOpens = children.filter((t: Token) => t.type === 'link_open');
    const linkCloses = children.filter((t: Token) => t.type === 'link_close');

    if (linkOpens.length !== 1 || linkCloses.length !== 1) continue;

    // Ensure there's no text outside the link
    const linkOpenIdx = children.indexOf(linkOpens[0]);
    const linkCloseIdx = children.indexOf(linkCloses[0]);
    let hasOutsideText = false;
    for (let j = 0; j < children.length; j++) {
      if (j >= linkOpenIdx && j <= linkCloseIdx) continue;
      if (children[j].type === 'text' && children[j].content.trim() !== '') {
        hasOutsideText = true;
        break;
      }
    }
    if (hasOutsideText) continue;

    const href = linkOpens[0].attrGet('href');
    if (!href || !isImageUrl(href)) continue;

    const escapedHref = md.utils.escapeHtml(href);

    // Replace paragraph_open + inline + paragraph_close with html_block
    const imgToken = new state.Token('html_block', '', 0);
    imgToken.content = `<div class="image-embed"><img src="${escapedHref}" alt="" loading="lazy" /></div>\n`;

    // Replace: tokens[i-1] = paragraph_open, tokens[i] = inline, tokens[i+1] = paragraph_close
    tokens.splice(i - 1, 3, imgToken);
    i--; // re-check from same position
  }
});

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const html = useMemo(() => md.render(content), [content]);

  return (
    <div
      className="markdown-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Tiny dependency-free syntax highlighter.
 * A position-scanning tokenizer: for each language a list of sticky regexes is
 * tried in order, the first match wins and becomes a coloured span.
 */

const COMMON_NUM = /^\b(?:0[xXoObB][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b/;
const COMMON_STR = /^(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)/;
const COMMON_SPACE = /^\s+/;
const COMMON_PUNCT = /^[^\w\s]/;

const LANGS = {
  python: [
    ['com', /^(?:#.*|"""[\s\S]*?"""|'''[\s\S]*?''')/],
    ['str', /^(?:[fFbBrRuU]{0,2}"(?:\\[\s\S]|[^"\\])*"?|[fFbBrRuU]{0,2}'(?:\\[\s\S]|[^'\\])*'?)/],
    ['num', COMMON_NUM],
    ['key', /^\b(?:def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|global|nonlocal|assert|del|async|await|match|case|print)\b/],
    ['op', /^\b(?:and|or|not|is|in|None|True|False|self|cls)\b/],
    ['fn', /^\b[A-Za-z_]\w*(?=\s*\()/],
    ['var', /^\b[A-Za-z_]\w*\b/],
    ['space', COMMON_SPACE],
    ['op', COMMON_PUNCT],
    ['plain', /^[\s\S]/],
  ],
  javascript: [
    ['com', /^(?:\/\/.*|\/\*[\s\S]*?\*\/)/],
    ['str', COMMON_STR],
    ['num', COMMON_NUM],
    ['key', /^\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|import|export|from|default|async|await|try|catch|finally|throw|yield|delete|void|of|in|static|get|set)\b/],
    ['op', /^\b(?:null|undefined|true|false|NaN|Infinity)\b/],
    ['fn', /^\b[A-Za-z_$][\w$]*(?=\s*\()/],
    ['var', /^\b[A-Za-z_$][\w$]*\b/],
    ['space', COMMON_SPACE],
    ['op', COMMON_PUNCT],
    ['plain', /^[\s\S]/],
  ],
  json: [
    ['attr', /^"(?:\\.|[^"\\])*"(?=\s*:)/],
    ['str', /^"(?:\\.|[^"\\])*"/],
    ['key', /^\b(?:true|false|null)\b/],
    ['num', COMMON_NUM],
    ['space', COMMON_SPACE],
    ['op', COMMON_PUNCT],
    ['plain', /^[\s\S]/],
  ],
  bash: [
    ['com', /^#.*/],
    ['str', COMMON_STR],
    ['key', /^\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|in|select|until|return|exit|export|local|readonly|source|alias)\b/],
    ['fn', /^\b(?:sudo|apt|apt-get|pip|pip3|npm|npx|yarn|pnpm|git|docker|kubectl|curl|wget|ls|cd|cat|echo|grep|sed|awk|find|rm|cp|mv|mkdir|chmod|chown|python|python3|node|make|cmake|cargo|go|ssh|scp|tar|zip|unzip|systemctl|brew|powershell|dir|type|del|copy|move)\b/],
    ['var', /^\$\{?[A-Za-z_]\w*\}?|^-[A-Za-z-]+|--[a-z-]+/],
    ['num', COMMON_NUM],
    ['space', COMMON_SPACE],
    ['op', COMMON_PUNCT],
    ['plain', /^[\s\S]/],
  ],
  powershell: [
    ['com', /^#.*/],
    ['str', COMMON_STR],
    ['key', /^\b(?:param|function|if|else|elseif|foreach|for|while|switch|try|catch|finally|return|exit|begin|process|end)\b/],
    ['fn', /^\b[A-Z][a-z]+-[A-Za-z]+\b/],
    ['var', /^\$[A-Za-z_]\w*/],
    ['num', COMMON_NUM],
    ['space', COMMON_SPACE],
    ['op', COMMON_PUNCT],
    ['plain', /^[\s\S]/],
  ],
  html: [
    ['com', /^<!--[\s\S]*?-->/],
    ['str', /^(?:"[^"]*"|'[^']*')/],
    ['tag', /^<\/?[A-Za-z][\w:-]*/],
    ['tag', /^\/?>/],
    ['attr', /^\b[A-Za-z_:][\w:.-]*(?==)/],
    ['space', COMMON_SPACE],
    ['op', COMMON_PUNCT],
    ['plain', /^[\s\S]/],
  ],
  css: [
    ['com', /^\/\*[\s\S]*?\*\//],
    ['str', COMMON_STR],
    ['key', /^@[\w-]+/],
    ['fn', /^[a-z-]+(?=\()/],
    ['attr', /^[-A-Za-z]+(?=\s*:)/],
    ['tag', /^[.#][\w-]+|^::?[\w-]+/],
    ['num', /^[-+]?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b|^#[0-9a-fA-F]{3,8}\b/],
    ['space', COMMON_SPACE],
    ['op', COMMON_PUNCT],
    ['plain', /^[\s\S]/],
  ],
  yaml: [
    ['com', /^#.*/],
    ['attr', /^[\w.-]+(?=\s*:)/],
    ['str', COMMON_STR],
    ['key', /^\b(?:true|false|null|yes|no|on|off)\b/],
    ['num', COMMON_NUM],
    ['op', /^[-*>|&!%]/],
    ['space', COMMON_SPACE],
    ['plain', /^[\s\S]/],
  ],
  sql: [
    ['com', /^(?:--.*|\/\*[\s\S]*?\*\/)/],
    ['str', /^'(?:''|[^'])*'/],
    ['key', /^\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|AS|AND|OR|NOT|NULL|PRIMARY|KEY|FOREIGN|REFERENCES|INDEX|VIEW|WITH|UNION|ALL|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END)\b/i],
    ['num', COMMON_NUM],
    ['fn', /^\b[A-Za-z_]\w*(?=\s*\()/],
    ['var', /^\b[A-Za-z_][\w$]*\b/],
    ['space', COMMON_SPACE],
    ['op', COMMON_PUNCT],
    ['plain', /^[\s\S]/],
  ],
  go: [
    ['com', /^(?:\/\/.*|\/\*[\s\S]*?\*\/)/],
    ['str', /^(?:"(?:\\.|[^"\\])*"|`[^`]*`)/],
    ['key', /^\b(?:package|import|func|var|const|type|struct|interface|map|chan|go|defer|return|if|else|for|range|switch|case|default|break|continue|select|fallthrough)\b/],
    ['op', /^\b(?:nil|true|false|iota)\b/],
    ['fn', /^\b[A-Za-z_]\w*(?=\s*\()/],
    ['var', /^\b[A-Za-z_]\w*\b/],
    ['num', COMMON_NUM],
    ['space', COMMON_SPACE],
    ['op', COMMON_PUNCT],
    ['plain', /^[\s\S]/],
  ],
  rust: [
    ['com', /^(?:\/\/.*|\/\*[\s\S]*?\*\/)/],
    ['str', /^(?:"(?:\\.|[^"\\])*")/],
    ['key', /^\b(?:fn|let|mut|const|static|struct|enum|impl|trait|pub|use|mod|crate|self|Self|match|if|else|for|while|loop|break|continue|return|where|as|in|ref|move|async|await|dyn|unsafe|type)\b/],
    ['op', /^\b(?:true|false|None|Some|Ok|Err)\b/],
    ['fn', /^\b[a-z_]\w*(?=[!(])/],
    ['var', /^\b[A-Za-z_]\w*\b/],
    ['num', COMMON_NUM],
    ['space', COMMON_SPACE],
    ['op', COMMON_PUNCT],
    ['plain', /^[\s\S]/],
  ],
  c: [
    ['com', /^(?:\/\/.*|\/\*[\s\S]*?\*\/)/],
    ['str', /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])')/],
    ['key', /^\b(?:int|char|float|double|void|long|short|unsigned|signed|const|static|struct|union|enum|typedef|sizeof|return|if|else|for|while|do|switch|case|break|continue|default|goto|extern|inline|register|volatile|#include|#define|#ifdef|#ifndef|#endif|#pragma)\b/],
    ['op', /^\b(?:NULL|true|false)\b/],
    ['fn', /^\b[A-Za-z_]\w*(?=\s*\()/],
    ['var', /^\b[A-Za-z_]\w*\b/],
    ['num', COMMON_NUM],
    ['space', COMMON_SPACE],
    ['op', COMMON_PUNCT],
    ['plain', /^[\s\S]/],
  ],
  markdown: [
    ['key', /^#{1,6} .*/],
    ['op', /^(\*{1,3}|_{1,3}|~~)(?=\S)/],
    ['str', /^`[^`]*`/],
    ['fn', /^\[[^\]]*\]\([^)]*\)/],
    ['com', /^> .*/],
    ['space', COMMON_SPACE],
    ['plain', /^[\s\S]/],
  ],
  diff: [
    ['com', /^(?:^|\n)(?:diff|index|---|\+\+\+).*/],
    ['str', /^(?:^|\n)@@[\s\S]*?@@/],
    ['plain', /^[\s\S]/],
  ],
};

const ALIASES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', node: 'javascript',
  ts: 'javascript', tsx: 'javascript', typescript: 'javascript',
  py: 'python', python3: 'python', py3: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', 'shell-session': 'bash', bat: 'powershell',
  batch: 'powershell', ps: 'powershell', ps1: 'powershell',
  yml: 'yaml', json5: 'json', jsonc: 'json',
  htm: 'html', xml: 'html', vue: 'html', svelte: 'html', svg: 'html',
  scss: 'css', less: 'css', sass: 'css',
  golang: 'go', rs: 'rust', 'c++': 'c', cpp: 'c', h: 'c', hpp: 'c', cs: 'c', java: 'c', kotlin: 'c',
  md: 'markdown', patch: 'diff', udiff: 'diff',
  ini: 'yaml', toml: 'yaml', env: 'bash', dockerfile: 'bash', makefile: 'bash',
};

export function normalizeLanguage(lang) {
  const key = String(lang || '').toLowerCase().trim();
  if (!key) return 'text';
  return ALIASES[key] || (LANGS[key] ? key : 'text');
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


/** Remove regex start-anchors that are outside character classes. */
export function stripAnchors(source) {
  let out = '';
  let inClass = false;
  let escaped = false;
  let atAlternative = true;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    if (char === '^' && !inClass && atAlternative) {
      atAlternative = false;
      continue;
    }
    if (char === '(' || char === '|') atAlternative = true;
    else if (char !== '^') atAlternative = false;
    out += char;
  }
  return out;
}

/** Highlight source code, returning safe HTML. */
const COMPILED = new Map();

function compiledRules(language) {
  if (COMPILED.has(language)) return COMPILED.get(language);
  // Rules are written with ^ anchors for readability; sticky regexes must not
  // keep them, otherwise only position 0 would ever match. Anchors inside
  // character classes ([^abc]) are preserved.
  const rules = (LANGS[language] || []).map(([className, rule]) => [
    className,
    new RegExp(stripAnchors(rule.source), 'y'),
  ]);
  COMPILED.set(language, rules);
  return rules;
}

export function highlight(code, lang = 'text') {
  const language = normalizeLanguage(lang);
  const source = String(code ?? '');
  if (language === 'text') return escapeHtml(source);
  const rules = compiledRules(language);
  if (!rules.length) return escapeHtml(source);
  const limit = Math.min(source.length, 400000);
  const parts = [];
  let index = 0;
  while (index < limit) {
    let matched = false;
    for (const [className, rule] of rules) {
      rule.lastIndex = index;
      const result = rule.exec(source);
      if (result && result[0].length) {
        const text = result[0];
        parts.push(
          className === 'space' || className === 'plain'
            ? escapeHtml(text)
            : `<span class="tok-${className}">${escapeHtml(text)}</span>`,
        );
        index += text.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      parts.push(escapeHtml(source[index]));
      index += 1;
    }
  }
  if (source.length > limit) parts.push(escapeHtml(source.slice(limit)));
  return parts.join('');
}

/** Render a unified diff with coloured lines. */
export function renderDiff(diffText) {
  return String(diffText || '')
    .split('\n')
    .map((line) => {
      let className = '';
      if (line.startsWith('+++') || line.startsWith('---')) className = 'meta';
      else if (line.startsWith('@@')) className = 'hunk';
      else if (line.startsWith('+')) className = 'add';
      else if (line.startsWith('-')) className = 'del';
      else if (line.startsWith('diff ') || line.startsWith('index ')) className = 'meta';
      return `<span class="diff-line ${className}">${escapeHtml(line) || '&nbsp;'}</span>`;
    })
    .join('');
}

/** Minimal ANSI colour support for terminal output. */
const ANSI_COLORS = {
  30: '#4b5263', 31: '#ff5c6c', 32: '#35d07f', 33: '#f5b942', 34: '#4ea1ff',
  35: '#c792ea', 36: '#00c2a8', 37: '#d7dce6', 90: '#6a7387', 91: '#ff8b96',
  92: '#7ee2a8', 93: '#ffd97a', 94: '#8fc4ff', 95: '#e0b3ff', 96: '#6fe3ff', 97: '#ffffff',
};

export function renderAnsi(text) {
  const raw = String(text || '');
  if (!raw.includes('\u001b')) return escapeHtml(raw);
  let out = '';
  let open = false;
  const re = /\u001b\[([0-9;]*)m/g;
  let last = 0;
  let match;
  while ((match = re.exec(raw)) !== null) {
    out += escapeHtml(raw.slice(last, match.index));
    last = re.lastIndex;
    const codes = match[1].split(';').filter(Boolean).map(Number);
    for (const code of codes) {
      if (code === 0) {
        if (open) { out += '</span>'; open = false; }
      } else if (ANSI_COLORS[code]) {
        if (open) { out += '</span>'; }
        out += `<span style="color:${ANSI_COLORS[code]}">`;
        open = true;
      } else if (code === 1) {
        if (open) { out += '</span>'; }
        out += '<span style="font-weight:700">';
        open = true;
      }
    }
  }
  out += escapeHtml(raw.slice(last));
  if (open) out += '</span>';
  return out;
}

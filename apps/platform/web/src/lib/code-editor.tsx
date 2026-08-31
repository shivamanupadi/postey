/**
 * The one CodeMirror surface for the whole dashboard, lazy-loaded so the main
 * bundle stays lean. Light linen theme only - values match the approved
 * mockups exactly: linen surface, tinted gutter, sienna tags/keywords, green
 * strings, coral {{variables}}.
 */
import type { ReactElement } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { Decoration, EditorView, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export type CodeLang = 'html' | 'shell' | 'javascript' | 'python' | 'text';

/** Short docs get padded with blank lines so the gutter never looks stubby. */
const MIN_LINES = 10;
const padLines = (s: string): string => {
  const n = s.split('\n').length;
  return n >= MIN_LINES ? s : s + '\n'.repeat(MIN_LINES - n);
};

const linenTheme = EditorView.theme({
  '&': { backgroundColor: '#fbf8f3', fontSize: '12px' },
  '.cm-content': {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    padding: '8px 0',
    lineHeight: '1.75',
    color: '#3d3a35',
  },
  '.cm-gutters': { backgroundColor: '#f6f2ec', color: '#8a867f', border: 'none' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(229,221,207,0.35)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(229,221,207,0.5)' },
  '.cm-tplvar': { color: '#e63757', fontWeight: '600' },
});

const linenHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.tagName, t.angleBracket, t.keyword], color: '#a86423' },
    { tag: [t.attributeName, t.propertyName], color: '#57534e' },
    { tag: [t.string, t.attributeValue, t.special(t.string)], color: '#1a7f4e' },
    { tag: [t.comment, t.meta], color: '#8a867f' },
    { tag: [t.number, t.bool, t.null], color: '#a86423' },
  ])
);

/** {{variables}} pop in coral regardless of language. */
const tplVarMatcher = new MatchDecorator({
  regexp: /\{\{[^{}\n]*\}\}/g,
  decoration: Decoration.mark({ class: 'cm-tplvar' }),
});
const templateVars = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = tplVarMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = tplVarMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: v => v.decorations }
);

const langOf = (lang: CodeLang) => {
  switch (lang) {
    case 'html':
      return [html()];
    case 'javascript':
      return [javascript()];
    case 'python':
      return [python()];
    case 'shell':
      return [StreamLanguage.define(shell)];
    default:
      return [];
  }
};

export default function CodeEditor({
  value,
  onChange,
  lang = 'text',
  height,
  readOnly = false,
  placeholder,
}: {
  value: string;
  onChange?: (v: string) => void;
  lang?: CodeLang;
  /** e.g. "240px" or "100%" - forwarded to CodeMirror. */
  height?: string;
  readOnly?: boolean;
  placeholder?: string;
}): ReactElement {
  return (
    <CodeMirror
      value={padLines(value)}
      onChange={onChange}
      readOnly={readOnly}
      theme="none"
      extensions={[...langOf(lang), linenTheme, linenHighlight, templateVars, EditorView.lineWrapping]}
      height={height}
      basicSetup={{
        foldGutter: false,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
      }}
      placeholder={placeholder}
    />
  );
}

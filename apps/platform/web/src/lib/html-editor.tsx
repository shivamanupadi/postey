/** CodeMirror HTML editor, split into its own chunk - it is only loaded when a
 *  template modal opens, keeping the main bundle lean. */
import type { ReactElement } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { html } from '@codemirror/lang-html';
import { EditorView } from '@codemirror/view';

const cmTheme = EditorView.theme({
  '&': { backgroundColor: '#fbf8f3', fontSize: '12.5px' },
  '.cm-content': { fontFamily: "'JetBrains Mono', ui-monospace, monospace", padding: '10px 0' },
  '.cm-gutters': { backgroundColor: '#f6f2ec', color: '#8a867f', border: 'none' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(229,221,207,0.35)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(229,221,207,0.5)' },
});

export default function HtmlEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): ReactElement {
  return (
    <div className="overflow-hidden rounded-[10px] border border-line transition focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={[html(), cmTheme, EditorView.lineWrapping]}
        height="240px"
        basicSetup={{ foldGutter: false, highlightActiveLine: true }}
        placeholder="<h1>Hi {{name}}</h1>"
      />
    </div>
  );
}

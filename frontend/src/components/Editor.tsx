import { sql, StandardSQL } from "@codemirror/lang-sql";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView, Decoration, MatchDecorator, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";

const jinja = new MatchDecorator({ regexp: /\{\{[\s\S]*?\}\}|\{%-?[\s\S]*?-?%\}|\{#[\s\S]*?#\}/g, decoration: Decoration.mark({ class: "cm-jinja" }) });
const jinjaPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = jinja.createDeco(view); }
  update(u: ViewUpdate) { this.decorations = jinja.updateDeco(u, this.decorations); }
}, { decorations: (v) => v.decorations });

const hl = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--accent-text)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "var(--green)" },
  { tag: [t.number, t.bool, t.null], color: "var(--orange)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--label3)", fontStyle: "italic" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--accent-text)" },
  { tag: [t.typeName], color: "var(--yellow)" },
  { tag: [t.punctuation, t.bracket], color: "var(--label2)" },
]);

export function Editor({ value, onChange, path, readOnly, fontSize = 12, theme, onSave, onRun, onPreview }: {
  value: string; onChange?: (v: string) => void; path: string; readOnly?: boolean; fontSize?: number; theme: string;
  onSave?: () => void; onRun?: (upstream: boolean) => void; onPreview?: () => void;
}) {
  const ext = useMemo(() => {
    const lang = /\.ya?ml$/.test(path) ? [yaml()] : /\.sql$/.test(path) ? [sql({ dialect: StandardSQL, upperCaseKeywords: false })] : /\.py$/.test(path) ? [python()] : [];
    return [
      ...lang,
      ...(/\.py$/.test(path) ? [] : [jinjaPlugin]),
      syntaxHighlighting(hl),
      EditorView.lineWrapping,
      EditorView.theme({ "&": { fontSize: `${fontSize}px` } }),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (onSave?.(), true) },
        { key: "Mod-r", preventDefault: true, run: () => (onRun?.(false), true) },
        { key: "Shift-Mod-r", preventDefault: true, run: () => (onRun?.(true), true) },
        { key: "Mod-Enter", preventDefault: true, run: () => (onPreview?.(), true) },
      ]),
    ];
  }, [path, fontSize, onSave, onRun, onPreview]);
  return (
    <div className="cm-wrap">
      <CodeMirror value={value} onChange={onChange} extensions={ext} readOnly={readOnly} editable={!readOnly} theme={theme === "dark" ? "dark" : "light"}
        basicSetup={{ foldGutter: false, highlightActiveLine: !readOnly, autocompletion: true, searchKeymap: true }} height="100%" style={{ height: "100%" }} />
    </div>
  );
}

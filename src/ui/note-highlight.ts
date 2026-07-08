import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export const setNoteHighlight = StateEffect.define<{ from: number; to: number } | null>();

export const noteHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },

  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setNoteHighlight)) continue;
      if (effect.value === null) {
        next = Decoration.none;
        continue;
      }

      const docLength = tr.state.doc.length;
      const from = Math.max(0, Math.min(effect.value.from, docLength));
      const to = Math.max(0, Math.min(effect.value.to, docLength));
      next =
        from < to
          ? Decoration.set([
              Decoration.mark({ class: "rsvp-reader-active-sentence" }).range(from, to),
            ])
          : Decoration.none;
    }
    return next;
  },

  provide: (field) => EditorView.decorations.from(field),
});

export function highlightInEditor(
  view: EditorView,
  range: { from: number; to: number } | null,
): void {
  const docLength = view.state.doc.length;
  const hasFiniteRange =
    range !== null && Number.isFinite(range.from) && Number.isFinite(range.to);
  const from = hasFiniteRange ? Math.max(0, Math.min(range.from, docLength)) : 0;
  const to = hasFiniteRange ? Math.max(0, Math.min(range.to, docLength)) : 0;
  const valid = from < to;

  // Decoration only; scrolling is done by the caller via the documented
  // Obsidian Editor.scrollIntoView(range, true) so centering is reliable.
  view.dispatch({ effects: setNoteHighlight.of(valid ? { from, to } : null) });
}

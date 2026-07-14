import { StateEffect, StateField, type StateEffectType } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

function makeHighlightField(
  effect: StateEffectType<{ from: number; to: number } | null>,
  cls: string,
) {
  return StateField.define<DecorationSet>({
    create() {
      return Decoration.none;
    },

    update(deco, tr) {
      let next = deco.map(tr.changes);
      for (const eff of tr.effects) {
        if (!eff.is(effect)) continue;
        if (eff.value === null) {
          next = Decoration.none;
          continue;
        }

        const docLength = tr.state.doc.length;
        const from = Math.max(0, Math.min(eff.value.from, docLength));
        const to = Math.max(0, Math.min(eff.value.to, docLength));
        next =
          from < to
            ? Decoration.set([Decoration.mark({ class: cls }).range(from, to)])
            : Decoration.none;
      }
      return next;
    },

    provide: (field) => EditorView.decorations.from(field),
  });
}

export const setNoteHighlight = StateEffect.define<{ from: number; to: number } | null>();
/** The stronger word-level mark used by the "locate" flash. */
export const setWordHighlight = StateEffect.define<{ from: number; to: number } | null>();

export const noteHighlightField = makeHighlightField(setNoteHighlight, "rsvp-reader-active-sentence");
export const wordHighlightField = makeHighlightField(setWordHighlight, "rsvp-reader-active-word");

/** Everything main.ts must register for the in-note highlights to render. */
export const noteHighlightExtensions = [noteHighlightField, wordHighlightField];

function sanitizeRange(
  view: EditorView,
  range: { from: number; to: number } | null,
): { from: number; to: number } | null {
  const docLength = view.state.doc.length;
  const hasFiniteRange =
    range !== null && Number.isFinite(range.from) && Number.isFinite(range.to);
  const from = hasFiniteRange ? Math.max(0, Math.min(range.from, docLength)) : 0;
  const to = hasFiniteRange ? Math.max(0, Math.min(range.to, docLength)) : 0;
  return from < to ? { from, to } : null;
}

export function highlightInEditor(
  view: EditorView,
  range: { from: number; to: number } | null,
): void {
  // Decoration only; scrolling is done by the caller via the documented
  // Obsidian Editor.scrollIntoView(range, true) so centering is reliable.
  view.dispatch({ effects: setNoteHighlight.of(sanitizeRange(view, range)) });
}

/** Word-level flash mark (see setWordHighlight); the caller times its removal. */
export function highlightWordInEditor(
  view: EditorView,
  range: { from: number; to: number } | null,
): void {
  view.dispatch({ effects: setWordHighlight.of(sanitizeRange(view, range)) });
}

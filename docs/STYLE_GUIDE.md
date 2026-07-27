# PaifuPlus UI style guide

The app is vanilla TypeScript + a single hand-written stylesheet
([`src/ui/style.css`](../src/ui/style.css)). To keep it coherent without a
framework, visuals are driven by a small set of CSS custom properties (tokens)
and a few shared classes. Prefer a token or an existing class over a one-off
value.

## Color & surface tokens

| Token | Use |
| --- | --- |
| `--bg` | page background; also the "inset well" behind grouped fields |
| `--panel` | panel/card surface |
| `--panel2` | raised surface: field fills, tabs, buttons, chips |
| `--line` | default border / divider |
| `--fg` / `--muted` | primary / secondary text |
| `--accent` | interactive accent (focus, primary button, active tab) |
| `--danger` | destructive action |
| `--radius` | panel/card corner radius (8px) |
| `--mono` | the one monospace stack — use everywhere code is shown |

Surfaces nest lightest-on-top: a field (`--panel2`) sits on a panel
(`--panel`) which sits on the page (`--bg`). When a field sits inside another
`--panel2` box, make that box `--bg` so the field still reads as raised (see
`.stream-quick`).

## Editable fields

Every text input, number, textarea, and select shares **one** look through the
`.field-control` class, configured by these tokens:

| Token | Default | Meaning |
| --- | --- | --- |
| `--field-bg` | `--panel2` | fill |
| `--field-border` | `--line` | resting border |
| `--field-border-hover` | `--muted` | hover border |
| `--field-focus` | `--accent` | focus border (no default outline) |
| `--field-radius` | 6px | corner radius |
| `--field-pad` | 6px 8px | padding |

Rules:

- **Always** add `field-control` to an editable control. Add `mono` for
  code-like content (tile notation, the stream DSL, JSON):
  ```ts
  el('input',   { class: 'field-control', ... })            // text / select
  el('textarea',{ class: 'field-control mono', ... })       // code
  ```
- Give a field **only its own geometry** locally — width, a textarea's
  `min-height`/`resize`, a number's right-align, the title's larger type.
  Never restate background / border / radius / focus; that's the token set's
  job.
- Number fields drop their native spinners automatically (type to edit).

This is what keeps the title, the stream transcription, the form editor, and
the replay comment box looking like the same control. Regressions almost always
come from a field that skipped `field-control` and hand-rolled its own
background or border.

## Buttons, tabs, dialogs

- Buttons: `.btn`, plus `.primary` / `.danger` / `.small` / `.icon` /
  `.has-icon` modifiers.
- Icons are inline SVGs from [`icon.ts`](../src/ui/icon.ts) (`.mi`), inheriting
  `currentColor`. Add new glyphs there rather than pulling in a font.
- Modals go through [`dialog.ts`](../src/ui/dialog.ts) (`openDialog`).

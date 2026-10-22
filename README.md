# DuckNotes

A free note-taking app for Windows, made for lectures. It works like OneNote, but your notes stay on your own computer.

- **Notebooks and pages.** Each notebook is a folder in `Documents\DuckNotes`, and each page is a file in it. Pages save by themselves as you type.
- **An endless page.** Click anywhere to start writing. Text sits in boxes: drag the top edge to move one, or the right edge to make it wider. An empty box disappears when you leave it, as in OneNote.
- **Pictures.** Ctrl+V pastes a picture where you last clicked. Pasted while writing, it goes into the text. You can also drop picture files onto the page. Drag a picture to move it, or its corner to resize it.
- **Drawing everywhere.** The pen, highlighter and eraser work over the whole page, text included. A stylus draws even while you're typing. Its eraser end rubs out.
- **Diagrams.** Draw boxes, circles and diamonds, which ask for their words as you draw them. Arrows drawn from one shape to another stay attached when the shapes move.
- **Zoom.** Use Ctrl+scroll wheel or a touchpad pinch, or the buttons in the bottom-right corner. Dragging an empty spot moves the view.
- **Quick writing.** While typing:
  - `# ` makes a heading;
  - `- ` makes a list, `1. ` a numbered list, and `[] ` or `[x] ` a checklist;
  - `$x^2$` makes an equation;
  - `->` becomes →;
  - web addresses become links.
- **Tables.** Pick the size from the toolbar. Tab moves to the next cell, and pressing it in the last cell adds a row.
- **Equations.** Typeset maths in a LaTeX-like shorthand, with a preview and buttons for the common shapes.
- **Paper.** Plain, lined or squared.
- **Search.** Ctrl+E searches every notebook, and the matches are marked on the page.
- **Print or save as PDF.** Ctrl+P prints the page on its own (choose "Microsoft Print to PDF" to save a PDF); also in the page's right-click menu.
- **Nothing lost.** Deleting moves things to `Documents\DuckNotes\.trash`, with an Undo.

## Keys

| | |
|---|---|
| Ctrl+N | New page |
| Ctrl+E | Search all notes |
| Ctrl+P | Print the page, or save it as PDF |
| Ctrl+Z / Ctrl+Y | Undo / redo (typing, or drawing and moving things) |
| Ctrl+B / I / U | Bold / italic / underline |
| Ctrl+- | Strikethrough |
| Ctrl+Shift+H | Highlight text |
| Alt+scroll wheel, Ctrl+] / Ctrl+[ | Bigger / smaller text |
| Ctrl+. / Ctrl+/ | Bullets / numbering |
| Ctrl+1 | Checkbox: add, tick, untick |
| Ctrl+Shift+1, 2, 3 / Ctrl+0 | Heading 1, 2, 3 / normal text |
| Alt+= | Equation |
| Alt+Shift+D / Alt+Shift+T | Today's date / the time |
| Ctrl+K | Link |
| Ctrl+click | Open a link |
| Ctrl+scroll wheel | Zoom |

When you're not typing, these letters pick a tool:

| Key | Tool |
|---|---|
| T or Esc | Type |
| V | Select (drag empty space to move the view) |
| P | Pen |
| H | Highlighter |
| E | Eraser |
| L | Line |
| A | Arrow |
| R | Box |
| O | Circle |
| D | Diamond |

Delete removes what's selected.

## Building

```
npm install
npm test
npm run tauri build -- --no-bundle
npm run smoke
```

`npm run smoke` drives the built app with its notes in a scratch folder, never in Documents.

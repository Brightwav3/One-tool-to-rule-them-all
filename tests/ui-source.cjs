/* Reconstitutes converter/ui/index.html as it was before the decomposition.
 *
 * The suite in test_ui_state.cjs asserts against roughly two hundred CSS rules,
 * function bodies and markup fragments by reading index.html as one string.
 * Those strings did not change when the UI came apart - they just live in
 * styles/app.css and the extracted scripts now. Inlining every <link> and
 * <script src> back in document order rebuilds exactly the string those
 * assertions were written against, so the suite keeps testing the UI rather
 * than testing where its files sit.
 *
 * Concatenation is the right model here because the extracted scripts are
 * classic <script> tags, which the browser evaluates as if they were one file
 * in load order. That equivalence is what made the extraction safe in the first
 * place; this reuses it.
 */
const fs = require('node:fs');
const path = require('node:path');

const UI_DIR = path.join(__dirname, '..', 'converter', 'ui');

/* Git checks these files out with CRLF on Windows, but the assertions were
   written against LF: a regex holding a literal newline cannot match a
   carriage-return newline pair. The suite is about content, not line endings,
   so normalise everything it reads. */
const CR = String.fromCharCode(13), NL = String.fromCharCode(10);
const lf = text => text.split(CR + NL).join(NL);

function readLocal(src) {
  if (!src.startsWith('/')) return null;              // leave remote or relative refs alone
  const file = path.join(UI_DIR, src.slice(1));
  return fs.existsSync(file) ? lf(fs.readFileSync(file, 'utf8')) : null;
}

/* index.html with every local stylesheet and script inlined where its tag sat. */
function inlinedIndexHtml() {
  const html = lf(fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8'));
  return html
    .replace(/<link rel="stylesheet" href="([^"]+)">/g, (tag, href) => {
      const css = readLocal(href);
      return css === null ? tag : `<style>\n${css}</style>`;
    })
    .replace(/<script src="([^"]+)"><\/script>/g, (tag, src) => {
      const js = readLocal(src);
      return js === null ? tag : `<script>\n${js}</script>`;
    });
}

function rawIndexHtml() {
  return lf(fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8'));
}

module.exports = { inlinedIndexHtml, rawIndexHtml, UI_DIR };

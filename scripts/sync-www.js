const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const www = path.join(root, 'www');
const fontDir = path.join(www, 'fonts');
const srcPath = path.join(root, 'index.html');
const html = fs.readFileSync(srcPath, 'utf8');

const googleFonts = /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\r?\n<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\r?\n<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Orbitron:wght@500;700;900&display=swap" rel="stylesheet">/;

const localFonts = `<style>
@font-face{font-family:'Orbitron';font-style:normal;font-weight:500;font-display:swap;src:url('fonts/orbitron-latin-500-normal.woff2') format('woff2')}
@font-face{font-family:'Orbitron';font-style:normal;font-weight:700;font-display:swap;src:url('fonts/orbitron-latin-700-normal.woff2') format('woff2')}
@font-face{font-family:'Orbitron';font-style:normal;font-weight:900;font-display:swap;src:url('fonts/orbitron-latin-900-normal.woff2') format('woff2')}
</style>`;

if (!googleFonts.test(html)) {
  console.error('index.html no longer has the expected Google Fonts tags. Update scripts/sync-www.js.');
  process.exit(1);
}

const files = ['orbitron-latin-500-normal.woff2', 'orbitron-latin-700-normal.woff2', 'orbitron-latin-900-normal.woff2'];
const fontSrc = path.join(root, 'node_modules', '@fontsource', 'orbitron', 'files');
fs.mkdirSync(fontDir, { recursive: true });
for (const file of files) {
  const from = path.join(fontSrc, file);
  if (!fs.existsSync(from)) {
    console.error('Missing font file: ' + from);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(fontDir, file));
}

fs.writeFileSync(path.join(www, 'index.html'), html.replace(googleFonts, localFonts));
console.log('Synced index.html and Orbitron into www/');

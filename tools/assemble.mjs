// Inlines all src/ modules into one self-contained index.html.
// Dev:   node tools/assemble.mjs --dev   -> src/dev.html (modules loaded directly, three from node_modules)
// Final: node tools/assemble.mjs         -> index.html  (bundled inline, three from jsDelivr via import map)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

const THREE_VERSION = '0.186.1';
const dev = process.argv.includes('--dev');
let shell = readFileSync('src/shell.html', 'utf8');

if (dev) {
  shell = shell.replace('__THREE_URL__', '/node_modules/three/build/three.module.js')
    .replace('__THREE_ADDONS_URL__', '/node_modules/three/examples/jsm/')
    .replace('<!--MAIN_SCRIPT-->', '<script type="module" src="/src/main.js"></script>')
    .replace('<!--HEADER_COMMENT-->', '');
  writeFileSync('src/dev.html', shell);
  console.log('wrote src/dev.html');
} else {
  const res = await build({
    entryPoints: ['src/main.js'], bundle: true, format: 'esm', write: false, external: ['three', 'three/addons/*'],
    target: 'es2022', minify: false, legalComments: 'inline', charset: 'utf8',
  });
  let code = res.outputFiles[0].text;
  // prevent "</script" inside the inline script
  code = code.replace(/<\/script/gi, '<\\/script');
  const header = readFileSync('src/HEADER.txt', 'utf8');
  shell = shell.replace('__THREE_URL__', `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.js`)
    .replace('__THREE_ADDONS_URL__', `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/`)
    .replace('<!--HEADER_COMMENT-->', () => `<!--\n${header.replace(/--/g, '—')}\n-->`)
    .replace('<!--MAIN_SCRIPT-->', () => `<script type="module">\n${code}\n</script>`);
  writeFileSync('index.html', shell);
  mkdirSync('public', { recursive: true });
  writeFileSync('public/index.html', shell); // what the Cloudflare Worker serves (wrangler.jsonc)
  console.log(`wrote index.html + public/index.html (${(shell.length / 1024).toFixed(0)} KB)`);
}

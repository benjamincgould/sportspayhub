// Test only: bundles the real app screens for a browser run (Next.js does this on Vercel).
// React comes from this machine's global install; Tailwind v4's API compiles the v3 config.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, 'dist');
const G = '/home/claude/.npm-global/lib/node_modules';
const req = createRequire('/opt/npm-tools/node_modules/');
const esbuild = req('esbuild');
fs.mkdirSync(out, { recursive: true });

fs.writeFileSync(path.join(out, 'entry.jsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ClientApp from ${JSON.stringify(path.join(root, 'components/ClientApp.jsx'))};
createRoot(document.getElementById('app')).render(<React.StrictMode><ClientApp /></React.StrictMode>);
`);
await esbuild.build({
  entryPoints: [path.join(out, 'entry.jsx')], bundle: true, format: 'esm', outfile: path.join(out, 'app.js'),
  jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, minify: false, logLevel: 'warning',
  alias: { react: `${G}/react`, 'react-dom': `${G}/react-dom`, 'react/jsx-runtime': `${G}/react/jsx-runtime.js`, qrcode: path.join(here, 'qrcode-stub.js') },
});

// CSS: same config and variables as app/globals.css
const tw = req('tailwindcss');
const twDir = path.dirname(req.resolve('tailwindcss/package.json'));
const globals = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8').replace(/@tailwind \w+;\n/g, '');
const compiler = await tw.compile(`@import "tailwindcss";\n@config "${path.join(root, 'tailwind.config.mjs')}";\n${globals}`, {
  base: root,
  loadStylesheet: async (id, base) => {
    const p = id === 'tailwindcss' ? path.join(twDir, 'index.css') : path.resolve(base, id);
    return { path: p, base: path.dirname(p), content: fs.readFileSync(p, 'utf8') };
  },
  loadModule: async (id, base) => {
    const p = path.isAbsolute(id) ? id : path.resolve(base, id);
    return { path: p, base: path.dirname(p), module: (await import(pathToFileURL(p).href)).default };
  },
});
const candidates = new Set();
for (const f of fs.readdirSync(path.join(root, 'components'))) {
  for (const m of fs.readFileSync(path.join(root, 'components', f), 'utf8').matchAll(/[\w:/.\[\]%#()-]+/g)) candidates.add(m[0]);
}
fs.writeFileSync(path.join(out, 'app.css'), compiler.build([...candidates]));
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test</title><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>`);
console.log('built', (fs.statSync(path.join(out, 'app.js')).size / 1024).toFixed(0), 'KB js,', (fs.statSync(path.join(out, 'app.css')).size / 1024).toFixed(0), 'KB css');

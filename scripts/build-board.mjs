import { build } from 'esbuild';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function buildBoard({ sourceDir = path.join(root, 'web'), outDir = path.join(root, 'dist/board') } = {}) {
  sourceDir = await realpath(sourceDir);
  // Keep earlier fingerprinted chunks available to tabs opened before a deploy.
  // Stable source URLs remain available for older clients and local debugging.
  await mkdir(outDir, { recursive: true });
  await cp(sourceDir, outDir, { recursive: true });
  const options = {
    absWorkingDir: root,
    outdir: path.join(outDir, 'assets'),
    entryNames: '[name]-[hash]',
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    metafile: true,
    legalComments: 'eof',
  };
  const result = await build({
    ...options,
    entryPoints: Object.fromEntries(['bootstrap.js', 'app.js', 'style.css']
      .map(name => [path.parse(name).name, path.join(sourceDir, name)])),
  });
  // This helper executes as a classic script inside an opaque sandbox, where
  // ES modules would require CORS. Keep it self-contained.
  const helper = await build({
    ...options, splitting: false, format: 'iife',
    entryPoints: { 'bilibili-metadata': path.join(sourceDir, 'bilibili-metadata.js') },
  });
  Object.assign(result.metafile.inputs, helper.metafile.inputs);
  Object.assign(result.metafile.outputs, helper.metafile.outputs);
  const outputs = result.metafile.outputs;
  const entry = name => Object.keys(outputs).find(output => outputs[output].entryPoint
    && path.resolve(root, outputs[output].entryPoint) === path.join(sourceDir, name));
  const assetURL = output => '/' + path.relative(outDir, path.resolve(root, output)).split(path.sep).join('/');
  const preloads = new Set();
  const preload = output => {
    if (preloads.has(output)) return;
    preloads.add(output);
    for (const imported of outputs[output].imports) {
      if (!imported.external && imported.kind === 'import-statement') preload(imported.path);
    }
  };
  // Discover the home bundle and its shared imports immediately, without
  // preloading any optional feature or Markdown parser.
  preload(entry('app.js'));
  const html = (await readFile(path.join(sourceDir, 'index.html'), 'utf8'))
    .replace('href="/style.css"', `href="${assetURL(entry('style.css'))}"`)
    .replace('src="/bootstrap.js"', `src="${assetURL(entry('bootstrap.js'))}"`)
    .replace('</head>', [...preloads].map(output => `  <link rel="modulepreload" href="${assetURL(output)}">`).join('\n') + '\n</head>');
  await writeFile(path.join(outDir, 'index.html'), html);
  const metadata = (await readFile(path.join(sourceDir, 'bilibili-metadata.html'), 'utf8'))
    .replace('src="/bilibili-metadata.js"', `src="${assetURL(entry('bilibili-metadata.js'))}"`);
  await writeFile(path.join(outDir, 'bilibili-metadata.html'), metadata);
  return { metafile: result.metafile, preloads: [...preloads].map(assetURL) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await buildBoard();
  console.log(`Board assets built; ${result.preloads.length} modules preloaded for the home page.`);
}

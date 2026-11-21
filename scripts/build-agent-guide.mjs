import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const source=readFileSync(new URL('../docs/AGENT_LOOP.md',import.meta.url),'utf8');
const installation = source.match(/^## 安装白板与长期记忆\r?\n\r?\n```text\r?\n([\s\S]*?)\r?\n```$/m);
if (!installation) throw new Error('Agent guide is missing the installation instructions');
const generated='// Generated from docs/AGENT_LOOP.md by scripts/build-agent-guide.mjs.\n// Edit the Markdown source, then regenerate.\nexport const GUIDE_TEXT = [\n'+source.split('\n').map(line=>'  '+JSON.stringify(line)).join(',\n')+'\n].join("\\n");\n'+
  `export const GUIDE_BOOTSTRAP = ${JSON.stringify(installation[1])};\n`;
const output = new URL('../src/agent-guide-content.js', import.meta.url);
if (!existsSync(output) || readFileSync(output, 'utf8') !== generated) {
  writeFileSync(output, generated);
}

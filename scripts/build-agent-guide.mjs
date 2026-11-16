import { readFileSync, writeFileSync } from 'node:fs';
const source=readFileSync(new URL('../docs/AGENT_LOOP.md',import.meta.url),'utf8');
const generated='// Generated from docs/AGENT_LOOP.md by scripts/build-agent-guide.mjs.\n// Edit the Markdown source, then regenerate.\nexport const GUIDE_TEXT = [\n'+source.split('\n').map(line=>'  '+JSON.stringify(line)).join(',\n')+'\n].join("\\n");\n';
writeFileSync(new URL('../src/agent-guide-content.js',import.meta.url),generated);

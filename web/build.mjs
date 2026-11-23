import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const out = new URL('./dist/', import.meta.url);
const asset = name => new URL(name, out);
await mkdir(asset('static/'), {recursive:true});
for (const name of ['app.js','style.css']) {
  await cp(new URL('../mvp/static/'+name,import.meta.url),asset('static/'+name));
}
for (const name of ['workspace.js','demo.js']) {
  await cp(new URL('./'+name,import.meta.url),asset('static/'+name));
}
await cp(new URL('./node_modules/exceljs/dist/exceljs.min.js',import.meta.url),asset('static/exceljs.min.js'));
await cp(new URL('./node_modules/exceljs/LICENSE',import.meta.url),asset('static/exceljs-LICENSE'));
const html = await readFile(new URL('../mvp/static/index.html',import.meta.url),'utf8');
const scripts = ['exceljs.min.js','demo.js','workspace.js'].map(name=>'<script defer src="./static/'+name+'"></script>').join('');
await writeFile(asset('index.html'),html.replace('<meta charset="utf-8">',`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'">`).replaceAll('"/static/','"./static/').replace('<script defer',scripts+'<script defer'));
await writeFile(asset('.nojekyll'),'');
if (process.env.EVALUATION_SOURCE_ZIP !== 'skip') {
  execFileSync('git',['archive','--format=zip','--prefix=ai-safety-evaluation/','--output='+asset('source.zip').pathname,'HEAD']);
}

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = ['roundtrip', 'edit', 'selectors', 'ui', 'interact', 'fs-e2e', 'wysiwyg', 'full', 'regression'];
const env = { ...process.env };
if (process.argv.includes('--fixtures')) env.HEXO_EDITOR_POSTS_DIR = path.join(here, 'fixtures/posts');
let failures = 0;
for (const suite of suites) {
  process.stdout.write('\n[' + suite + ']\n');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, suite + '.test.mjs')], {
      cwd: path.dirname(here), env, stdio: 'inherit', windowsHide: true
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(suite + ': timeout')); }, 120000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); resolve(code ?? 1); });
  });
  if (code !== 0) failures++;
}
console.log('\nSuites: ' + suites.length + ', failed: ' + failures);
process.exitCode = failures ? 1 : 0;

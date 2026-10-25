// 格式层回归测试：对 source/_posts 下全部 .md 做「解析 → 序列化 → 逐字节比对」
// 用法：node hexo-editor/test/roundtrip.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('../assets/core.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const postsDir = path.resolve(here, '../../source/_posts');

let pass = 0;
const failures = [];

const files = fs.readdirSync(postsDir).filter((f) => f.endsWith('.md')).sort();
for (const name of files) {
  const full = path.join(postsDir, name);
  const raw = fs.readFileSync(full, 'utf8');
  let out;
  try {
    const doc = Core.parsePost(raw);
    out = Core.stringifyPost(doc);
  } catch (e) {
    failures.push({ name, kind: 'throw', detail: e.message });
    continue;
  }
  if (out === raw) {
    pass += 1;
    continue;
  }
  // 记录第一处差异
  let i = 0;
  while (i < Math.min(out.length, raw.length) && out[i] === raw[i]) i += 1;
  failures.push({
    name,
    kind: 'diff',
    at: i,
    input: JSON.stringify(raw.slice(Math.max(0, i - 40), i + 50)),
    output: JSON.stringify(out.slice(Math.max(0, i - 40), i + 50)),
    lenIn: raw.length,
    lenOut: out.length
  });
}

console.log(`总计 ${files.length} 篇，逐字节一致 ${pass} 篇，失败 ${failures.length} 篇`);
failures.slice(0, 6).forEach((f) => {
  console.log(`\n✗ ${f.name} (${f.kind})`);
  if (f.kind === 'diff') {
    console.log(`  首个差异位置 ${f.at}  长度 ${f.lenIn} -> ${f.lenOut}`);
    console.log(`  原文: ${f.input}`);
    console.log(`  输出: ${f.output}`);
  } else {
    console.log(`  ${f.detail}`);
  }
});

process.exit(failures.length === 0 ? 0 : 1);

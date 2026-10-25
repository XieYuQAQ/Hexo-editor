// 选择器静态审计：app.js 里用到的每个 #id / data-act / .class 钩子，都必须在 index.html 里真实存在
// 用法：node hexo-editor/test/selectors.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.resolve(here, '..');

const html = fs.readFileSync(path.join(editorDir, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(editorDir, 'assets/app.js'), 'utf8');
const css = fs.readFileSync(path.join(editorDir, 'assets/editor.css'), 'utf8');

let checks = 0;
let failed = 0;
function check(ok, label, extra) {
  checks += 1;
  if (!ok) {
    failed += 1;
    console.log(`✗ ${label}` + (extra ? `\n    ${extra}` : ''));
  }
}

/* ---------- 1. app.js 里出现的所有 #id ---------- */
const ids = new Set();
const idRe = /['"]#([A-Za-z][\w-]*)['"]/g;
const idRe2 = /getElementById\(['"]([\w-]+)['"]\)/g;
let m;
while ((m = idRe.exec(app))) ids.add(m[1]);
while ((m = idRe2.exec(app))) ids.add(m[1]);

const missingIds = [];
for (const id of ids) {
  if (id === 'f-') {
    // 动态拼接前缀 #f-<field>，逐个字段核对
    for (const f of ['title', 'abbrlink', 'description', 'date', 'cover', 'tags-input']) {
      if (!new RegExp(`id="f-${f}"`).test(html)) missingIds.push(`f-${f}`);
    }
    continue;
  }
  if (!new RegExp(`id="${id}"`).test(html)) missingIds.push(id);
}
check(missingIds.length === 0, `app.js 引用的 #id 全部存在于 index.html（共 ${ids.size} 个）`, missingIds.join(', '));

/* ---------- 2. 每个 data-act 在 action() 里有分支（或明确走弹窗） ---------- */
const acts = new Set();
const actRe = /data-act="([a-z0-9-]+)"/g;
while ((m = actRe.exec(html))) acts.add(m[1]);

const declared = new Set();
const caseRe = /case '([a-z0-9-]+)':/g;
while ((m = caseRe.exec(app))) declared.add(m[1]);

const missingActs = [...acts].filter((a) => !declared.has(a));
check(missingActs.length === 0, `工具栏 ${acts.size} 个按钮都在 action() 有实现`, missingActs.join(', '));

/* ---------- 3. $.selector 里出现的所有 class 钩子 ---------- */
const classSelectors = new Set();
const clsRe = /\$\$?\(['"]\.([a-zA-Z][\w-]*)['"]/g;
while ((m = clsRe.exec(app))) classSelectors.add(m[1]);
const missingCls = [];
for (const c of classSelectors) {
  // 动态生成的 class 由 JS 自己产出，这里只检查静态 HTML 里应该有的
  const inHtml = new RegExp(`class="[^"]*\\b${c}\\b`).test(html);
  const inApp = new RegExp(`class: '[^']*${c}`).test(app) || new RegExp(`'${c}`).test(app);
  if (!inHtml && !inApp) missingCls.push(c);
}
check(missingCls.length === 0, `app.js 查询的 .class 都有来源（共 ${classSelectors.size} 个）`, missingCls.join(', '));

/* ---------- 4. CSS 里的类在 HTML/JS 里有没有用（找出拼错的死样式） ---------- */
// 只检查明显属于组件命名的类，跳过状态类与伪类
const cssClasses = new Set();
const cssRe = /\.([a-z][\w-]{2,})(?=[\s,{:.\[])/g;
while ((m = cssRe.exec(css))) cssClasses.add(m[1]);

const orphan = [];
const ignore = new Set(['hidden', 'on', 'active', 'dirty', 'split', 'ok', 'err', 'warn', 'show', 'error',
  'invalid', 'has-img', 'unlocked', 'primary', 'danger', 'tiny', 'block', 'right', 'tagbtn', 'p-empty']);
for (const c of cssClasses) {
  if (ignore.has(c)) continue;
  const inHtml = new RegExp(`class="[^"]*\\b${c}\\b`).test(html);
  const inApp = app.includes(`'${c}`) || app.includes(` ${c}`) || app.includes(`${c}'`);
  if (!inHtml && !inApp) orphan.push(c);
}
check(orphan.length === 0, `CSS 里的 ${cssClasses.size} 个类都能对上 DOM`, orphan.join(', '));

/* ---------- 5. 脚本引用与文件存在性 ---------- */
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((x) => x[1]);
check(scripts.length === 2, `index.html 引入 ${scripts.length} 个脚本（core.js + app.js，无预览依赖）`);
for (const s of scripts) {
  check(fs.existsSync(path.join(editorDir, s)), `脚本存在: ${s}`);
}
const styles = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((x) => x[1]);
for (const s of styles) {
  check(fs.existsSync(path.join(editorDir, s)), `样式存在: ${s}`);
}

/* ---------- 6. HTML 结构完整性：标签闭合 ---------- */
const openDivs = (html.match(/<div\b/g) || []).length;
const closeDivs = (html.match(/<\/div>/g) || []).length;
check(openDivs === closeDivs, `<div> 开闭配对 (${openDivs}/${closeDivs})`);
const openSec = (html.match(/<section\b/g) || []).length;
const closeSec = (html.match(/<\/section>/g) || []).length;
check(openSec === closeSec, `<section> 开闭配对 (${openSec}/${closeSec})`);
const openLbl = (html.match(/<label\b/g) || []).length;
const closeLbl = (html.match(/<\/label>/g) || []).length;
check(openLbl === closeLbl, `<label> 开闭配对 (${openLbl}/${closeLbl})`);
const openBtn = (html.match(/<button\b/g) || []).length;
const closeBtn = (html.match(/<\/button>/g) || []).length;
check(openBtn === closeBtn, `<button> 开闭配对 (${openBtn}/${closeBtn})`);

/* ---------- 7. 重复 id 检查 ---------- */
const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]);
const dup = allIds.filter((x, i) => allIds.indexOf(x) !== i);
check(dup.length === 0, '没有重复 id', [...new Set(dup)].join(', '));

console.log(`\n选择器审计 ${checks} 条，失败 ${failed} 条`);
process.exit(failed === 0 ? 0 : 1);

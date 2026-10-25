// 交互测试：通过 window.HexoEditor 真的在界面上操作（改标题、改标签、插入 Markdown、保存、删除…）
// 用法：node hexo-editor/test/interact.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('D:/ZEROKAMI/node_modules/jsdom');

const here = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.resolve(here, '..');
const postsDir = path.resolve(here, '../../source/_posts');

let checks = 0;
let failed = 0;
function check(ok, label, extra) {
  checks += 1;
  if (!ok) {
    failed += 1;
    console.log(`✗ ${label}` + (extra ? `\n    ${extra}` : ''));
  }
}

function boot() {
  const html = fs.readFileSync(path.join(editorDir, 'index.html'), 'utf8')
    .replace(/<script src="assets\/[^"]+"><\/script>/g, '');
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;
  if (!w.URL.createObjectURL) w.URL.createObjectURL = () => 'blob:mock';
  if (!w.URL.revokeObjectURL) w.URL.revokeObjectURL = () => {};
  w.indexedDB = undefined;
  for (const file of ['core.js', 'app.js']) {
    w.eval(fs.readFileSync(path.join(editorDir, 'assets', file), 'utf8'));
  }
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return dom;
}

function fire(w, node, type) {
  node.dispatchEvent(new w.Event(type, { bubbles: true }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const sampleA = fs.readFileSync(path.join(postsDir, '25 迈从G3 A鼠标开箱.md'), 'utf8');
const sampleB = fs.readFileSync(path.join(postsDir, '26 半高SATA硬盘盒开箱.md'), 'utf8');

/* ================================================================
 * 1. 打开文章：表单回填正确
 * ================================================================ */
const dom = boot();
const w = dom.window;
const d = w.document;
const E = w.HexoEditor;
const Core = w.HexoCore;

E.setMode('files', []);
const pA = E.loadFromText('25 迈从G3 A鼠标开箱.md', sampleA);

check(d.querySelector('#editor').classList.contains('hidden') === false, '打开后编辑器可见');
check(d.querySelector('#f-title').value === '迈从G3 A鼠标开箱', 'title 回填', d.querySelector('#f-title').value);
check(d.querySelector('#f-abbrlink').value === 'f15d35d0', 'abbrlink 回填', d.querySelector('#f-abbrlink').value);
check(d.querySelector('#f-date').value === '2025-09-28 12:00:00', 'date 回填', d.querySelector('#f-date').value);
check(d.querySelector('#f-cover').value === '/images/2025/09/03339e8c7f.jpg', 'cover 回填', d.querySelector('#f-cover').value);
check(d.querySelector('#f-description').value.includes('迈从G3'), 'description 回填（折叠块已展开）');

/* 标签 chips */
const chips = Array.from(d.querySelectorAll('#tags-chips .chip span:first-child')).map((x) => x.textContent);
check(JSON.stringify(chips) === JSON.stringify(['外设', '生活', '硬件']), '标签 chips 渲染', chips.join(','));

/* 锁定状态 */
check(d.querySelector('#f-abbrlink').disabled === false, '已有 abbrlink → 解锁');
check(d.querySelector('#f-date').disabled === false, '已存在文件 → 日期解锁');
check(d.querySelector('#lock-abbrlink').textContent === '🔓', 'abbrlink 锁图标为解锁');

/* front matter 预览 */
E.renderFrontMatter();
const fm = d.querySelector('#frontmatter-view').textContent;
check(fm.startsWith('---\ntitle: 迈从G3 A鼠标开箱'), 'front matter 预览标题行', fm.split('\n')[1]);
check(fm.includes('tags: [外设, 生活, 硬件]'), 'front matter 预览 tags 行');

/* ================================================================
 * 2. 编辑标题 → dirty 状态
 * ================================================================ */
const titleInput = d.querySelector('#f-title');
titleInput.value = '迈从G3 A鼠标开箱（新标题）';
fire(w, titleInput, 'input');

check(pA.dirty === true, '改标题后标记为脏');
check(d.querySelector('#dirty-dot').classList.contains('on'), '出现未保存圆点');
check(d.querySelector('#save-state').textContent === '未保存', '状态栏显示未保存');
check(d.querySelectorAll('#post-list li.dirty').length === 1, '列表项标记为脏');

const out = E.currentText();
check(out.includes('title: 迈从G3 A鼠标开箱（新标题）'), '序列化带新标题');
check(out.includes('abbrlink: f15d35d0'), '其余字段保持原样');
check(Core.splitFront(out).body === Core.splitFront(sampleA).body, '正文未变');

/* ================================================================
 * 3. 标签增删
 * ================================================================ */
E.addTag('DIY');
let tags = Core.get(E.state.current.doc, 'tags');
check(JSON.stringify(tags) === JSON.stringify(['外设', '生活', '硬件', 'DIY']), 'addTag 追加', tags.join(','));
check(E.currentText().includes('tags: [外设, 生活, 硬件, DIY]'), '序列化 tags 空格分隔');

// 点 chip 上的 ×
const removeBtn = d.querySelector('#tags-chips .chip button');
removeBtn.click();
tags = Core.get(E.state.current.doc, 'tags');
check(JSON.stringify(tags) === JSON.stringify(['生活', '硬件', 'DIY']), '点击 × 删除标签', tags.join(','));

// 逗号分隔一次加多个
E.addTag('A, B');
tags = Core.get(E.state.current.doc, 'tags');
check(tags.includes('A') && tags.includes('B'), '逗号分隔批量添加');

/* ================================================================
 * 4. 工具栏：真的把 Markdown 插进正文
 * ================================================================ */
const body = d.querySelector('#body');
const getBody = () => E.getBody();
function selectAll() { E.selectAll(); }
function caretEnd() {
  const n = getBody().length;
  E.setSel(n, n);
}

const before = getBody().length;
selectAll();
E.action('table');
check(getBody().includes('| 列 1 | 列 2 | 列 3 |'), '插入表格', getBody().slice(-120));
check(getBody().length !== before, '正文已改变');

caretEnd();
E.action('bilibili');
// 视频块要弹窗，这里直接测底层函数
const block = Core.buildVideoBlock({ bvid: 'BV1CibC6BEdT', youtube: 'bI5YOkr5-Lc' });
check(block.startsWith('<div id="videoContainer">'), '视频块开头正确');
check(block.includes('checkGoogle()'), '视频块含 checkGoogle');
check(block.includes('player.bilibili.com'), '视频块含 B 站地址');
check(block.includes('youtube.com/embed/bI5YOkr5-Lc'), '视频块含 YouTube 地址');
check(block.trim().endsWith('</script>'), '视频块结尾为 </script>');

// 关闭可能弹出来的 modal
const modal = d.querySelector('#modal');
if (!modal.classList.contains('hidden')) d.querySelector('#modal-close').click();

/* 行内格式 */
caretEnd();
E.insertBlock('**粗体**');
check(getBody().includes('**粗体**'), '插入加粗');

E.setBody(getBody() + '选中文字');
const len = getBody().length;
E.setSel(len - 4, len);
E.action('italic');
check(getBody().endsWith('*选中文字*'), '斜体包裹选区', getBody().slice(-20));

/* 列表前缀 */
E.setBody('第一行\n第二行\n第三行');
E.selectAll();
E.action('ul');
check(getBody() === '- 第一行\n- 第二行\n- 第三行', '无序列表前缀', JSON.stringify(getBody()));

E.setBody('甲\n乙');
E.selectAll();
E.action('ol');
check(getBody() === '1. 甲\n2. 乙', '有序列表编号', JSON.stringify(getBody()));

E.setBody('引用内容');
E.selectAll();
E.action('quote');
check(getBody() === '> 引用内容', '引用前缀');

/* 正文改动后 doc.body 同步 */
check(E.state.current.doc.body === getBody(), 'doc.body 与正文同步');

/* ================================================================
 * 5. 保存（导入模式 → 下载；这里拦截 Blob 下载）
 * ================================================================ */
let downloaded = null;
w.URL.createObjectURL = function (blob) {
  downloaded = blob;
  return 'blob:mock';
};
const clicked = [];
const origCreate = d.createElement.bind(d);
d.createElement = function (tag) {
  const node = origCreate(tag);
  if (String(tag).toLowerCase() === 'a') {
    node.click = function () { clicked.push({ name: node.download }); };
  }
  return node;
};

// jsdom 的 Blob 没有 text()，用 FileReader 读回来
function blobText(blob) {
  return new Promise((resolve, reject) => {
    const fr = new w.FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(blob);
  });
}

const nameInput = d.querySelector('#file-name');
nameInput.value = '25 迈从G3 A鼠标开箱.md';
await E.savePost({ force: true });
check(clicked.length === 1, '保存触发一次下载', JSON.stringify(clicked));
check(clicked[0].name === '25 迈从G3 A鼠标开箱.md', '下载文件名正确', clicked[0].name);
const savedText = await blobText(downloaded);
check(savedText.includes('title: 迈从G3 A鼠标开箱（新标题）'), '下载内容含新标题');
check(savedText.includes('tags: [生活, 硬件, DIY, A, B]'), '下载内容含新标签', savedText.split('\n').find((l) => l.startsWith('tags:')));
check(pA.dirty === false, '保存后脏标记清除');
check(d.querySelector('#save-state').textContent === '已保存', '保存后状态栏');
check(savedText.endsWith('\n') || savedText.length > 0, '内容非空');

/* ================================================================
 * 7. 文件名校验 + abbrlink 锁定逻辑
 * ================================================================ */
const newP = E.loadFromText('新文章.md', '', { isNew: true, dirty: true });
check(d.querySelector('#f-abbrlink').value === '', '新文章 abbrlink 为空');
check(d.querySelector('#f-abbrlink').disabled === true, '新文章 abbrlink 锁定');
check(d.querySelector('#lock-abbrlink').textContent === '🔒', '新文章 abbrlink 锁图标为锁定');

/* 点锁 → 临时解锁 */
d.querySelector('#lock-abbrlink').click();
check(d.querySelector('#f-abbrlink').disabled === false, '点击锁可临时解锁 abbrlink');

/* ================================================================
 * 8. 新建文章：字段顺序与默认值
 * ================================================================ */
const created = Core.createPost({ title: '新建测试', tags: ['测试'], description: '描述' });
const text = Core.stringifyPost(created);
const keys = Core.splitFront(text).front.map((l) => l.split(':')[0]);
check(JSON.stringify(keys) === JSON.stringify(['title', 'abbrlink', 'description', 'tags', 'date', 'cover']),
  '新文章字段顺序', keys.join(','));
check(/^abbrlink:\s*$/.test(Core.splitFront(text).front[1]), '新文章 abbrlink 留空', JSON.stringify(Core.splitFront(text).front[1]));
check(/^date: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(Core.splitFront(text).front[4]), '新文章 date 有值');

/* ================================================================
 * 9. 删除（导入模式，仅从列表移除）
 * ================================================================ */
const countBefore = E.state.posts.length;
d.querySelector('#btn-delete').click();
await sleep(30);
const delModal = d.querySelector('#modal');
check(!delModal.classList.contains('hidden'), '删除弹出确认框');
const delBtns = Array.from(delModal.querySelectorAll('#modal-foot .btn'));
const confirm = delBtns.find((b) => b.textContent === '删除');
confirm.click();
await sleep(50);
check(E.state.posts.length === countBefore - 1, '删除后列表少一篇', `${countBefore} -> ${E.state.posts.length}`);

/* ================================================================
 * 10. 搜索与排序
 * ================================================================ */
E.setMode('files', []);
E.loadFromText('A.md', sampleA);
E.loadFromText('B.md', sampleB);
const searchBox = d.querySelector('#search');
searchBox.value = '硬盘盒';
fire(w, searchBox, 'input');
await sleep(200);
check(d.querySelectorAll('#post-list li').length === 1, '搜索过滤生效', d.querySelectorAll('#post-list li').length);
searchBox.value = '';
fire(w, searchBox, 'input');
await sleep(200);
check(d.querySelectorAll('#post-list li').length === 2, '清空搜索恢复列表');

/* 标签过滤：两篇都含「硬件」，过滤后应仍是 2 篇；再叠一个只有 A 有的「外设」→ 1 篇 */
const tagBtn = Array.from(d.querySelectorAll('#tag-filter .tagbtn')).find((b) => b.textContent.startsWith('硬件'));
check(!!tagBtn, '标签筛选按钮存在');
tagBtn.click();
check(d.querySelectorAll('#post-list li').length === 2, '「硬件」命中 2 篇', d.querySelectorAll('#post-list li').length);
const tagBtn2 = Array.from(d.querySelectorAll('#tag-filter .tagbtn')).find((b) => b.textContent.startsWith('外设'));
check(!!tagBtn2, '「外设」按钮存在');
tagBtn2.click();
check(d.querySelectorAll('#post-list li').length === 1, '叠加「外设」后只剩 1 篇', d.querySelectorAll('#post-list li').length);

dom.window.close();

console.log(`\n交互断言 ${checks} 条，失败 ${failed} 条`);
process.exit(failed === 0 ? 0 : 1);

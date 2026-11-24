import { findPostsDir, pickPost, waitForBoot } from './helpers.mjs';
// 交互测试：通过 window.HexoEditor 真的在界面上操作（改标题、改标签、插入 Markdown、保存、删除…）
// 用法：node hexo-editor/test/interact.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const CoreNode = require('../assets/core.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.resolve(here, '..');

const postsDir = findPostsDir(here);

let checks = 0;
let failed = 0;
function check(ok, label, extra) {
  checks += 1;
  if (!ok) {
    failed += 1;
    console.log(`✗ ${label}` + (extra ? `\n    ${extra}` : ''));
  }
}

async function boot() {
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
  await waitForBoot(dom);
  return dom;
}

function fire(w, node, type) {
  node.dispatchEvent(new w.Event(type, { bubbles: true }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* 语料按特征挑，不绑定具体文件名：
 * A —— 字段齐全（title/abbrlink/date/cover/description/内联 tags≥2），用于回填与编辑断言；
 * B —— 与 A 至少共享一个标签，且另有一个 A 没有的标签，用于标签过滤断言。 */
const richRaw = (raw) =>
  /^title: \S/m.test(raw) && /^abbrlink: \S/m.test(raw) && /^date: \S/m.test(raw) &&
  /^cover: \S/m.test(raw) && /^description: (?!>|\|)\S/m.test(raw) &&
  /^tags: \[[^\]]*,[^\]]*\]/m.test(raw);

const sampleAInfo = pickPost(postsDir, richRaw, '字段齐全的文章');
const tagsA = CoreNode.get(CoreNode.parsePost(sampleAInfo.raw), 'tags');
const sampleBInfo = pickPost(postsDir, (raw, name) => {
  if (name === sampleAInfo.name) return false;
  const tags = CoreNode.get(CoreNode.parsePost(raw), 'tags');
  return Array.isArray(tags) &&
    tags.some((t) => tagsA.includes(t)) && tags.some((t) => !tagsA.includes(t));
}, '与 A 共享一个标签、且另有独立标签的文章');

const sampleA = sampleAInfo.raw;
const sampleB = sampleBInfo.raw;
const docA = CoreNode.parsePost(sampleA);
const docB = CoreNode.parsePost(sampleB);
const titleA = String(CoreNode.get(docA, 'title'));
const abbrA = String(CoreNode.get(docA, 'abbrlink'));
const dateA = String(CoreNode.get(docA, 'date'));
const coverA = String(CoreNode.get(docA, 'cover'));
const descA = String(CoreNode.get(docA, 'description'));
const tagsB = CoreNode.get(docB, 'tags');
const titleLineA = (sampleA.match(/^title:.*$/m) || [''])[0];
const tagsLineA = (sampleA.match(/^tags:.*$/m) || [''])[0];
const newTitleA = titleA + '（新标题）';

/* ================================================================
 * 1. 打开文章：表单回填正确
 * ================================================================ */
const dom = await boot();
const w = dom.window;
const d = w.document;
const E = w.HexoEditor;
const Core = w.HexoCore;

E.setMode('files', []);
const pA = E.loadFromText(sampleAInfo.name, sampleA);

check(d.querySelector('#editor').classList.contains('hidden') === false, '打开后编辑器可见');
check(d.querySelector('#f-title').value === titleA, 'title 回填', d.querySelector('#f-title').value);
check(d.querySelector('#f-abbrlink').value === abbrA, 'abbrlink 回填', d.querySelector('#f-abbrlink').value);
check(d.querySelector('#f-date').value === dateA, 'date 回填', d.querySelector('#f-date').value);
check(d.querySelector('#f-cover').value === coverA, 'cover 回填', d.querySelector('#f-cover').value);
check(d.querySelector('#f-description').value === descA, 'description 回填', d.querySelector('#f-description').value);

/* 标签 chips */
const chips = Array.from(d.querySelectorAll('#tags-chips .chip span:first-child')).map((x) => x.textContent);
check(JSON.stringify(chips) === JSON.stringify(tagsA), '标签 chips 渲染', chips.join(','));

/* 锁定状态 */
check(d.querySelector('#f-abbrlink').disabled === false, '已有 abbrlink → 解锁');
check(d.querySelector('#f-date').disabled === false, '已存在文件 → 日期解锁');
check(d.querySelector('#lock-abbrlink').textContent === '🔓', 'abbrlink 锁图标为解锁');

/* front matter 预览 */
E.renderFrontMatter();
const fm = d.querySelector('#frontmatter-view').textContent;
check(fm.startsWith('---\n' + titleLineA), 'front matter 预览标题行', fm.split('\n')[1]);
check(fm.includes(tagsLineA), 'front matter 预览 tags 行');

/* ================================================================
 * 2. 编辑标题 → dirty 状态
 * ================================================================ */
const titleInput = d.querySelector('#f-title');
titleInput.value = newTitleA;
fire(w, titleInput, 'input');

check(pA.dirty === true, '改标题后标记为脏');
check(d.querySelector('#dirty-dot').classList.contains('on'), '出现未保存圆点');
check(d.querySelector('#save-state').textContent === '未保存', '状态栏显示未保存');
check(d.querySelectorAll('#post-list li.dirty').length === 1, '列表项标记为脏');

const out = E.currentText();
check(String(Core.get(E.state.current.doc, 'title')) === newTitleA, '序列化带新标题', Core.get(E.state.current.doc, 'title'));
check(out.includes('abbrlink: ' + abbrA), '其余字段保持原样');
check(Core.splitFront(out).body === Core.splitFront(sampleA).body, '正文未变');

/* ================================================================
 * 3. 标签增删
 * ================================================================ */
E.addTag('DIY');
let tags = Core.get(E.state.current.doc, 'tags');
const expectedAfterAdd = tagsA.concat('DIY');
check(JSON.stringify(tags) === JSON.stringify(expectedAfterAdd), 'addTag 追加', tags.join(','));
check(E.currentText().includes('tags: [' + expectedAfterAdd.join(', ') + ']'), '序列化 tags 空格分隔');

// 点 chip 上的 ×（删掉第一个标签）
const removeBtn = d.querySelector('#tags-chips .chip button');
removeBtn.click();
tags = Core.get(E.state.current.doc, 'tags');
const expectedAfterRemove = tagsA.slice(1).concat('DIY');
check(JSON.stringify(tags) === JSON.stringify(expectedAfterRemove), '点击 × 删除标签', tags.join(','));

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
check(/^<div id="videoContainer-[^"]+">/.test(block), '视频块开头包含独立容器');
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
nameInput.value = sampleAInfo.name;
await E.savePost({ force: true });
check(clicked.length === 1, '保存触发一次下载', JSON.stringify(clicked));
check(clicked[0].name === sampleAInfo.name, '下载文件名正确', clicked[0].name);
const savedText = await blobText(downloaded);
const savedDoc = Core.parsePost(savedText);
check(String(Core.get(savedDoc, 'title')) === newTitleA, '下载内容含新标题', Core.get(savedDoc, 'title'));
const expectedSavedTags = tagsA.slice(1).concat('DIY', 'A', 'B');
check(JSON.stringify(Core.get(savedDoc, 'tags')) === JSON.stringify(expectedSavedTags),
  '下载内容含新标签', savedText.split('\n').find((l) => l.startsWith('tags:')));
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
const titleB = String(CoreNode.get(docB, 'title'));
searchBox.value = titleB;
fire(w, searchBox, 'input');
await sleep(200);
check(d.querySelectorAll('#post-list li').length === 1, '搜索过滤生效', d.querySelectorAll('#post-list li').length);
searchBox.value = '';
fire(w, searchBox, 'input');
await sleep(200);
check(d.querySelectorAll('#post-list li').length === 2, '清空搜索恢复列表');

/* 标签过滤：common 两篇都有，onlyA 只有 A 有 */
const commonTag = tagsA.find((t) => tagsB.includes(t));
const onlyATag = tagsA.find((t) => !tagsB.includes(t));
check(!!commonTag && !!onlyATag, '语料里既有共享标签也有 A 独有标签', tagsA.join(',') + ' / ' + tagsB.join(','));
const tagButton = (t) => Array.from(d.querySelectorAll('#tag-filter .tagbtn'))
  .find((b) => b.textContent.replace(/\s+\d+$/, '') === t);
const tagBtn = tagButton(commonTag);
check(!!tagBtn, '「' + commonTag + '」筛选按钮存在');
tagBtn.click();
check(d.querySelectorAll('#post-list li').length === 2, '「' + commonTag + '」命中 2 篇', d.querySelectorAll('#post-list li').length);
const tagBtn2 = tagButton(onlyATag);
check(!!tagBtn2, '「' + onlyATag + '」按钮存在');
tagBtn2.click();
check(d.querySelectorAll('#post-list li').length === 1, '叠加「' + onlyATag + '」后只剩 1 篇', d.querySelectorAll('#post-list li').length);

dom.window.close();

console.log(`\n交互断言 ${checks} 条，失败 ${failed} 条`);
process.exit(failed === 0 ? 0 : 1);

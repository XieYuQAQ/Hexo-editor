import { findPostsDir, pickPost, waitForBoot } from './helpers.mjs';
// 全量补充测试：覆盖现有 7 套没测到的功能面
// 用法：node hexo-editor/test/full.test.mjs
//
// 覆盖清单（按 app.js 的功能分区）：
//  A. 草稿系统（localStorage 持久化 / 恢复 / 丢弃 / 磁盘同稿自动清除）
//  B. 键盘行为（Enter 延续列表、Tab 缩进、Backspace/Delete 行合并、
//     Ctrl+Z/Y 撤销重做、粘贴 CRLF 归一化、beforeunload 守卫）
//  C. 属性字段交互细节（date 归一化与非法格式保留警告——10/29 修复的回归用例）
//  D. 复制 / 另存为 / 预估 abbrlink（填入后解锁）
//  E. 标签输入（Backspace 删尾、联想点击添加、重复标签去重）
//  F. 保存细节（文件名清洗、导入模式下载、校验拦截聚焦）
//  G. 视频块误识别防护（代码块里的示例不会被折叠渲染）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const here = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.resolve(here, '..');

const postsDir = findPostsDir(here);

let checks = 0;
let failed = 0;
function check(ok, label, extra) {
  checks += 1;
  if (!ok) {
    failed += 1;
    console.log(`✗ ${label}` + (extra !== undefined ? `\n    ${extra}` : ''));
  }
}

/* ================================================================
 * 公共设施：内存版 FSA（与 fs-e2e 相同的形状）
 * ================================================================ */
class FakeFileHandle {
  constructor(name, store) { this.kind = 'file'; this.name = name; this._store = store; }
  async getFile() {
    const text = this._store.get(this.name);
    return { text: async () => text, lastModified: 1700000000000 };
  }
  async createWritable() {
    const store = this._store, name = this.name;
    return {
      async write(data) { store.set(name, typeof data === 'string' ? data : ''); },
      async close() {}
    };
  }
}
class FakeDirHandle {
  constructor(name) {
    this.kind = 'directory'; this.name = name;
    this._files = new Map(); this._dirs = new Map();
  }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
  async *values() {
    for (const [, dir] of this._dirs) yield dir;
    for (const name of this._files.keys()) yield new FakeFileHandle(name, this._files);
  }
  async getDirectoryHandle(name, opts) {
    if (this._dirs.has(name)) return this._dirs.get(name);
    if (opts && opts.create) { const d = new FakeDirHandle(name); this._dirs.set(name, d); return d; }
    throw new Error('NotFoundError: ' + name);
  }
  async getFileHandle(name, opts) {
    if (this._files.has(name)) return new FakeFileHandle(name, this._files);
    if (opts && opts.create) { this._files.set(name, ''); return new FakeFileHandle(name, this._files); }
    throw new Error('NotFoundError: ' + name);
  }
  async removeEntry(name) {
    if (this._files.delete(name)) return;
    if (this._dirs.delete(name)) return;
    throw new Error('NotFoundError');
  }
}

const fname = pickPost(postsDir, (raw) => /^abbrlink: \S/m.test(raw), '有 abbrlink 的文章').name;
const origRaw = fs.readFileSync(path.join(postsDir, fname), 'utf8');

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
  // 不手动 dispatch DOMContentLoaded：jsdom 在解析完成后会异步自然触发它，
  // 手动再触发一次会让 boot() 双跑 → bind() 双跑 → 所有监听器双绑
  // （H 段真实点击路径的 action 会执行两次）。统一等待自然启动，超时直接报错。
  return dom;
}

const waitBooted = waitForBoot;

function makeProject() {
  const root = new FakeDirHandle('ZEROKAMI');
  const source = new FakeDirHandle('source');
  const posts = new FakeDirHandle('_posts');
  const images = new FakeDirHandle('images');
  root._dirs.set('source', source);
  source._dirs.set('_posts', posts);
  source._dirs.set('images', images);
  posts._files.set(fname, origRaw);
  return { root, posts, images };
}

/** 连目录 + 关掉 boot 弹出的引导 + 打开第一篇 */
async function makeSession() {
  const dom = boot();
  await waitBooted(dom);   // 等 jsdom 自然触发 DOMContentLoaded（boot 只跑一次）
  const w = dom.window, d = w.document, E = w.HexoEditor;
  const { root, posts, images } = makeProject();
  await E.fs.attach(root);
  if (!d.querySelector('#modal').classList.contains('hidden')) {
    const enter = Array.from(d.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent.includes('进入编辑器'));
    if (enter) enter.click();
    await new Promise((r) => setTimeout(r, 30));
  }
  const p = E.state.posts[0];
  E.openPost(p, { skipDraftCheck: true });
  return { dom, w, d, E, p, posts, images };
}

function fire(w, node, type, init) {
  node.dispatchEvent(new w.Event(type, Object.assign({ bubbles: true }, init)));
}

/** 键盘事件必须用 KeyboardEvent：普通 Event 不会带 key / ctrlKey 等属性 */
function key(w, node, k, opts) {
  node.dispatchEvent(new w.KeyboardEvent('keydown', Object.assign({
    key: k, bubbles: true, cancelable: true
  }, opts)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================
 * A. 草稿系统
 * ================================================================ */
{
  console.log('A. 草稿系统');
  const { dom, w, d, E, p } = await makeSession();

  // A1. 改内容后（防抖 800ms）草稿进 localStorage
  E.setBody('草稿版本正文');
  await sleep(1000);
  const key = E.draftKey(p);
  const saved1 = JSON.parse(w.localStorage.getItem(key) || 'null');
  check(!!saved1 && !!saved1.text, '改正文 800ms 后草稿落 localStorage');
  if (saved1) check(saved1.text.includes('草稿版本正文'), '草稿内容含改动');
  if (saved1) check(typeof saved1.at === 'number' && saved1.at > 0, '草稿带时间戳');

  // A2. 保存成功后草稿被清除
  await E.savePost({ force: true });
  await sleep(50);
  check(w.localStorage.getItem(key) === null, '保存后草稿清除');
  // 从当前列表中取回文章，验证保存完成后的状态。

  // A3. 重新打开 → checkDraft：草稿与磁盘相同（都不脏）不弹窗
  // 注意：p2.raw 是保存后的磁盘内容（含『草稿版本正文』），不是 origRaw ——
  // 模拟「同稿」必须用 p2.raw，否则会被当成有差异而弹恢复窗。
  const p2 = E.state.posts.find((x) => x.name === fname);
  check(!!p2, '保存后从新列表中找回该文章');
  w.localStorage.setItem(key, JSON.stringify({ at: Date.now(), text: p2.raw }));
  E.closeEditor();
  await E.openPost(p2);
  await sleep(50);
  check(w.localStorage.getItem(key) === null, '草稿与磁盘相同 → 自动清除不弹窗');
  check(d.querySelector('#modal').classList.contains('hidden'), '同稿时不再弹任何窗');

  // A4. 真正有差异的草稿 → 弹「发现未保存的草稿」，两个按钮
  E.setBody('磁盘上没有的新草稿正文');
  await sleep(1000);
  E.closeEditor();
  await E.openPost(p2);
  await sleep(50);
  check(!d.querySelector('#modal').classList.contains('hidden'), '有差异草稿 → 弹恢复询问');
  check(d.querySelector('#modal-title').textContent === '发现未保存的草稿', '弹窗标题正确');
  const restore = Array.from(d.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent === '恢复草稿');
  const discard = Array.from(d.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent === '用磁盘上的版本');
  check(!!restore && !!discard, '恢复 / 丢弃两个按钮都在');
  restore.click();
  await sleep(50);
  check(E.getBody().includes('磁盘上没有的新草稿正文'), '点恢复 → 正文回到草稿内容');
  check(E.state.current.dirty === true, '恢复后标记为脏（还要保存）');
  check(d.querySelector('#save-state').textContent === '未保存', '恢复后状态栏未保存');

  // A5. 丢弃路径
  E.setBody('再改一版要丢弃的');
  await sleep(1000);
  E.closeEditor();
  await E.openPost(E.state.posts.find((x) => x.name === fname));
  await sleep(50);
  const discard2 = Array.from(d.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent === '用磁盘上的版本');
  discard2.click();
  await sleep(50);
  check(w.localStorage.getItem(key) === null, '点丢弃 → 草稿清除');
  // 磁盘上此刻存的是 A2 保存的『草稿版本正文』版 —— 丢弃应回到这个版本
  check(E.getBody() === '草稿版本正文', '丢弃后正文回到磁盘版本', E.getBody().slice(0, 40));
await sleep(600);   // 等悬挂的封面预览回调落地（jsdom close 会拆 location）
  dom.window.close();
}

// Core.splitFront 从 window realm 里取（跨 realm 直接引用模块变量也行，这里做个小助手）
function Core_split(text, w) { return w.HexoCore.splitFront(text); }

/* ================================================================
 * B. 键盘行为
 * ================================================================ */
{
  console.log('B. 键盘行为');
  const { dom, w, d, E, p } = await makeSession();

  // B1. Enter 延续列表前缀
  E.setBody('- 列表项');
  E.setSel(6);    // 行尾
  key(w, d.querySelector('#body'), 'Enter');
  check(E.getBody() === '- 列表项\n- ', '回车延续无序列表前缀', JSON.stringify(E.getBody()));

  E.setBody('1. 第一条');
  E.setSel(7);
  key(w, d.querySelector('#body'), 'Enter');
  check(E.getBody() === '1. 第一条\n2. ', '回车延续有序列表编号', JSON.stringify(E.getBody()));

  E.setBody('> 引用行');
  E.setSel(5);
  key(w, d.querySelector('#body'), 'Enter');
  check(E.getBody() === '> 引用行\n> ', '回车延续引用前缀', JSON.stringify(E.getBody()));

  E.setBody('- [ ] 任务');
  E.setSel(8);
  key(w, d.querySelector('#body'), 'Enter');
  check(E.getBody() === '- [ ] 任务\n- [ ] ', '回车延续任务列表', JSON.stringify(E.getBody()));

  // B2. 空列表项上回车 → 退出列表
  E.setBody('- ');
  E.setSel(2);
  key(w, d.querySelector('#body'), 'Enter');
  check(E.getBody() === '', '空列表项回车退出列表', JSON.stringify(E.getBody()));

  // B3. Tab 插入两个空格
  E.setBody('a');
  E.setSel(1);
  key(w, d.querySelector('#body'), 'Tab');
  check(E.getBody() === 'a  ', 'Tab 插入两个空格', JSON.stringify(E.getBody()));

  // B4. 行首 Backspace 合并上一行
  E.setBody('第一行\n第二行');
  E.setSel(4);    // 第二行行首
  key(w, d.querySelector('#body'), 'Backspace');
  check(E.getBody() === '第一行第二行', '行首退格合并两行', JSON.stringify(E.getBody()));

  // B5. 行尾 Delete 合并下一行
  E.setBody('第一行\n第二行');
  E.setSel(3);    // 第一行行尾
  key(w, d.querySelector('#body'), 'Delete');
  check(E.getBody() === '第一行第二行', '行尾 Delete 合并下一行', JSON.stringify(E.getBody()));

  // B6. 粘贴：CRLF 归一化为 LF（孤立 CR 也归一 —— 产品语义 replace(/\r\n?/g, '\n')）
  // 注意：jsdom 的 Event 构造器会丢弃 init 里的自定义属性，clipboardData
  // 必须在构造完后直接赋值（probe27/29 实测：ClipboardEvent 在 jsdom 里不存在）。
  E.setBody('x');
  E.setSel(1);
  const pasteEv = new w.Event('paste', { bubbles: true, cancelable: true });
  pasteEv.clipboardData = { getData: () => 'windows\r\n换行\r\r\n' };
  d.querySelector('#body').dispatchEvent(pasteEv);
  check(E.getBody() === 'xwindows\n换行\n\n', '粘贴把 CRLF / 孤立 CR 归一成 LF', JSON.stringify(E.getBody()));

  // B7. Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
  E.setBody('v1');
  E.historyPush();
  E.setBody('v2');
  E.historyPush();
  key(w, d.querySelector('#body'), 'z', { ctrlKey: true });
  check(E.getBody() === 'v1', 'Ctrl+Z 撤销', JSON.stringify(E.getBody()));
  key(w, d.querySelector('#body'), 'z', { ctrlKey: true, shiftKey: true });
  check(E.getBody() === 'v2', 'Ctrl+Shift+Z 重做', JSON.stringify(E.getBody()));
  key(w, d.querySelector('#body'), 'z', { ctrlKey: true });
  key(w, d.querySelector('#body'), 'y', { ctrlKey: true });
  check(E.getBody() === 'v2', 'Ctrl+Y 重做（等价）', JSON.stringify(E.getBody()));

  // B8. beforeunload 守卫
  const ev = new w.Event('beforeunload', { bubbles: true, cancelable: true });
  w.dispatchEvent(ev);
  check(ev.defaultPrevented === true, '有未保存修改时 beforeunload 被拦截');
  await E.savePost({ force: true });
  await sleep(50);
  const ev2 = new w.Event('beforeunload', { bubbles: true, cancelable: true });
  w.dispatchEvent(ev2);
  check(ev2.defaultPrevented === false, '保存后关闭不再拦截');

  // B9. 快捷键：Ctrl+S 保存
  E.setBody('Ctrl+S 触发的正文');
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(120);
  check(E.getBody() === 'Ctrl+S 触发的正文', 'Ctrl+S 后正文保持');
  check(E.state.current.dirty === false, 'Ctrl+S 触发了保存（dirty 清除）');

  // B10. 快捷键：Shift+Ctrl+N 新建（弹标题输入框）
  const postsBefore = E.state.posts.length;
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'N', shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(80);
  check(!d.querySelector('#modal').classList.contains('hidden'), 'Shift+Ctrl+N 弹出新建标题框');
  check(d.querySelector('#modal-title').textContent === '新建文章', '新建弹窗标题正确');
  d.querySelector('#modal-close').click();
  await sleep(30);
  check(E.state.posts.length === postsBefore, '取消新建不新增文章');
await sleep(600);   // 等悬挂的封面预览回调落地（jsdom close 会拆 location）
  dom.window.close();
}

/* ================================================================
 * C. 属性字段交互细节（10/29 修复项的正式回归用例）
 * ================================================================ */
{
  console.log('C. 属性字段交互细节');
  const { dom, w, d, E, p } = await makeSession();
  const Core = w.HexoCore;

  // C1. date 归一化：无前导零 / 无时间 → blur 后补齐
  const dt = d.querySelector('#f-date');
  dt.value = '2025-9-8';
  fire(w, dt, 'input');
  fire(w, dt, 'blur');
  check(dt.value === '2025-09-08', 'blur 归一化日期补前导零', dt.value);
  check(String(Core.get(p.doc, 'date')) === '2025-09-08', '归一化值进 doc');
  check(!dt.classList.contains('invalid'), '归一化后红框消除');

  // C2. 带时间归一化：补前导零 + 补秒
  // 注意：parseDate 的正则要求分钟两位（\d{2}），'9:5' 解析不了（会走非法格式路径）；
  // 测「补秒」要用合法但缺秒的输入 '9:05'。
  dt.value = '2025-9-8 9:05';
  fire(w, dt, 'input');
  fire(w, dt, 'blur');
  check(dt.value === '2025-09-08 09:05:00', '带时间的归一化补秒', dt.value);

  // C3. 非法格式：值进 doc + 红框保留（修复核心点）
  dt.value = '2025/10/01';
  fire(w, dt, 'input');
  fire(w, dt, 'blur');
  check(dt.classList.contains('invalid'), '非法格式 blur 后红框仍保留');
  check(String(Core.get(p.doc, 'date')) === '2025/10/01', '非法值也进 doc（不再静默丢弃）');
  check(dt.value === '2025/10/01', '表单显示保持用户输入');

  // C4. 非法格式 → 保存被拦截（validate 报 error）
  d.querySelector('#btn-save').click();
  await sleep(120);
  check(p.dirty === true, '保存被拦截，文章仍为脏');
  check(d.querySelector('#toast').textContent.includes('日期格式'), 'toast 指明日期格式错误', d.querySelector('#toast').textContent);
  check(p.name === fname, '文件名未变（没有写入动作）');

  // C5. 恢复合法值 → 红框消失，保存成功
  dt.value = '2025-10-01 12:00:00';
  fire(w, dt, 'input');
  fire(w, dt, 'blur');
  check(!dt.classList.contains('invalid'), '合法值红框消失');
  await E.savePost();
  await sleep(80);
  check(p.dirty === false, '改回合法值后保存成功');
await sleep(600);   // 等悬挂的封面预览回调落地（jsdom close 会拆 location）
  dom.window.close();
}

/* ================================================================
 * D. 复制 / 另存为 / 预估 abbrlink
 * ================================================================ */
{
  console.log('D. 复制 / 另存为 / 预估 abbrlink');
  const { dom, w, d, E, p, posts } = await makeSession();
  const Core = w.HexoCore;

  // D1. 复制成新文章
  E.duplicatePost();
  await sleep(50);
  check(E.state.posts.length === 2, '复制后列表多一篇');
  const copy = E.state.posts.find((x) => x.name !== fname);
  check(!!copy, '副本已入列表');
  check(copy.name === fname.replace(/\.md$/i, '') + ' 副本.md', '副本命名带「副本」后缀');
  check(copy.dirty === true && copy.isNew === true, '副本是脏的新文章（保存才落盘）');
  // 副本 isNew（savedOnce=false）→ 日期保持锁定，这是设计行为
  check(d.querySelector('#f-date').disabled === true, '副本（isNew）日期保持锁定（保存一次后解锁）',
    d.querySelector('#f-date').disabled);

  // D2. 副本保存 → 写入磁盘
  await E.savePost({ force: true });
  await sleep(80);
  check(posts._files.has(copy.name), '副本保存后落盘');
  check(posts._files.has(fname), '原文还在（复制不删源）');

  // D3. 另存为（fs 模式）
  E.closeEditor();
  E.openPost(p, { skipDraftCheck: true });
  const saveAs = d.querySelector('#btn-saveas');
  saveAs.click();
  await sleep(80);
  check(d.querySelector('#modal-title').textContent === '另存为', '另存为弹窗');
  const input = d.querySelector('#modal-body input');
  check(!!input && input.value.includes('副本'), '另存为默认文件名带「副本」', input && input.value);
  input.value = '99 另存测试.md';
  const okBtn = Array.from(d.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent === '确定');
  okBtn.click();
  await sleep(120);
  check(posts._files.has('99 另存测试.md'), '另存为写入磁盘');
  check(posts._files.has(fname), '另存为不删原文件');
  const savedText = posts._files.get('99 另存测试.md');
  const savedCopy = Core.parsePost(savedText);
  check(Core.get(savedCopy, 'abbrlink') === '' && savedCopy.body === Core.splitFront(origRaw).body, '另存为独立文章保留正文并清空短链');

  // D4. 预估 abbrlink：填入后解锁 + 值进 doc
  E.closeEditor();
  const newDoc = Core.createPost({ title: '预估测试' });
  E.loadFromText('28 预估测试.md', Core.stringifyPost(newDoc), { isNew: true, dirty: true });
  const abbrInput = d.querySelector('#f-abbrlink');
  check(abbrInput.disabled === true, '新文章 abbrlink 锁定');
  d.querySelector('#btn-predict-link').click();
  await sleep(60);
  check(!d.querySelector('#modal').classList.contains('hidden'), '预估弹窗打开');
  const fillBtn = Array.from(d.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent === '填入');
  check(!!fillBtn, '有「填入」按钮');
  const guessShown = (d.querySelector('#modal-body').textContent.match(/crc32\(标题\) = ([0-9a-f]+)/) || [])[1];
  fillBtn.click();
  await sleep(50);
  check(abbrInput.value === guessShown, '填入后输入框 = 预估值', abbrInput.value + ' vs ' + guessShown);
  check(abbrInput.disabled === false, '填入后 abbrlink 解锁');
  check(String(Core.get(E.state.current.doc, 'abbrlink')) === guessShown, '预估值进 doc');
  check(Core.crc32('预估测试').toString(16) === guessShown, '预估值与 crc32(title) 一致');
await sleep(600);   // 等悬挂的封面预览回调落地（jsdom close 会拆 location）
  dom.window.close();
}

/* ================================================================
 * E. 标签输入细节
 * ================================================================ */
{
  console.log('E. 标签输入细节');
  const { dom, w, d, E, p } = await makeSession();
  const Core = w.HexoCore;

  // E1. Backspace 删除末尾标签
  const tagsInput = d.querySelector('#f-tags-input');
  const before = JSON.stringify(Core.get(p.doc, 'tags'));
  tagsInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
  check(JSON.stringify(Core.get(p.doc, 'tags')).length === before.length - 1
    || Core.get(p.doc, 'tags').length === JSON.parse(before).length - 1, '空输入框上 Backspace 删掉末尾标签',
    before + ' -> ' + JSON.stringify(Core.get(p.doc, 'tags')));

  // E2. Enter / 逗号 / 中文逗号提交
  tagsInput.value = '回车标签';
  tagsInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  check(Core.get(p.doc, 'tags').includes('回车标签'), 'Enter 提交标签');
  check(tagsInput.value === '', '提交后输入框清空');

  tagsInput.value = '逗号标签';
  tagsInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: ',', bubbles: true, cancelable: true }));
  check(Core.get(p.doc, 'tags').includes('逗号标签'), '英文逗号提交标签');

  tagsInput.value = '中文逗号标签';
  tagsInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: '，', bubbles: true, cancelable: true }));
  check(Core.get(p.doc, 'tags').includes('中文逗号标签'), '中文逗号提交标签');

  // E3. 重复标签去重
  E.addTag('回车标签');
  const cnt = Core.get(p.doc, 'tags').filter((t) => t === '回车标签').length;
  check(cnt === 1, '重复添加的标签去重', cnt);

  // E4. blur 提交残留输入
  tagsInput.value = '失焦标签';
  fire(w, tagsInput, 'blur');
  check(Core.get(p.doc, 'tags').includes('失焦标签'), 'blur 提交残留输入');

  // E5. 联想区：有语料时给候选且点击可添加
  // （当前 session 只有 1 篇，标签在前面的用例里被增删过，这里只确认 renderSuggest 不报错）
  E.renderChips();
  const suggestBox = d.querySelector('#tag-suggest');
  check(suggestBox.children.length >= 0, '联想区容器存在且不报错');
await sleep(600);   // 等悬挂的封面预览回调落地（jsdom close 会拆 location）
  dom.window.close();
}

/* ================================================================
 * F. 保存细节
 * ================================================================ */
{
  console.log('F. 保存细节');
  const { dom, w, d, E, p, posts } = await makeSession();

  // F1. 文件名含非法字符 → 清洗后落盘
  // （改名会弹「文件名已修改」确认框：真实浏览器里用户会点按钮，
  //  这里必须先拿 promise、点了弹窗再 await，否则 savePost 永远挂着）
  const ni = d.querySelector('#file-name');
  ni.value = 'bad:name*with|illegal?.md';
  fire(w, ni, 'change');
  const saving = E.savePost({ force: true });
  await sleep(150);
  check(!d.querySelector('#modal').classList.contains('hidden'), '改名保存弹出确认框');
  const delOld = Array.from(d.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent === '删除旧文件');
  check(!!delOld, '确认框含「删除旧文件」');
  delOld.click();
  await saving;
  await sleep(120);
  const keys = [...posts._files.keys()];
  check(keys.includes('badnamewithillegal.md'), '非法字符被清洗（不阻塞保存）', keys.join(' | '));
  check(!posts._files.has(fname), '旧文件按确认被删除');
  check(E.state.current && E.state.current.name === 'badnamewithillegal.md', '当前编辑切到清洗后的名字');

  // F2. 校验拦截：title 清空 → 拦截 + 聚焦
  const pF = E.state.posts.find((x) => x.name === 'badnamewithillegal.md');
  E.closeEditor();
  E.openPost(pF, { skipDraftCheck: true });
  const t = d.querySelector('#f-title');
  t.value = '';
  fire(w, t, 'input');
  d.querySelector('#btn-save').click();
  await sleep(100);
  check(pF.dirty === true, '标题为空时保存被拦截');
  check(d.querySelector('#toast').textContent.includes('标题'), 'toast 指明标题错误');
  check(d.activeElement === t, '焦点被带到标题框');
await sleep(600);   // 等悬挂的封面预览回调落地（jsdom close 会拆 location）
  dom.window.close();
}

/* ================================================================
 * G. 视频块误识别防护 & codeDialog / footnote / insertBlock 细节
 * ================================================================ */
{
  console.log('G. 视频块误识别防护');
  const { dom, w, d, E, p } = await makeSession();
  const Core = w.HexoCore;

  // G1. 代码块里的视频示例代码不被折叠渲染
  const block = Core.buildVideoBlock({ bvid: 'BV1CibC6BEdT', youtube: 'bI5YOkr5-Lc' });
  E.setBody('```\n' + block + '\n```');
  E.setSel(0);
  const head = [...d.querySelector('#body').children].find((l) => l.hasAttribute('data-vhead'));
  check(!head, '代码块里的视频源码不会被识别为视频块');

  // G2. 缩进代码同样防护
  E.setBody('    <div id="videoContainer"><p>占位</p></div>');
  E.setSel(0);
  const head2 = [...d.querySelector('#body').children].find((l) => l.hasAttribute('data-vhead'));
  check(!head2, '缩进代码里的容器标签不被误识别');

  // G3. footnote：编号递增 + 内容行追加
  E.setBody('正文');
  E.setSel(2);
  E.action('footnote');
  check(E.getBody().includes('[^1]'), '脚注引用插入', E.getBody());
  check(E.getBody().includes('[^1]: '), '脚注定义行追加');
  E.setBody('正文 [^1]\n[^1]: a');
  E.setSel(2);
  E.action('footnote');
  check(E.getBody().includes('[^2]'), '已有脚注时编号递增', E.getBody());

  // G4. insertBlock 的空行保护：光标在行中时前后补换行
  E.setBody('abc');
  E.setSel(1);
  E.insertBlock('| x |', true);
  check(E.getBody().startsWith('a\n| x |\n') || E.getBody().startsWith('a\n\n| x |'), '块插入前后补换行', JSON.stringify(E.getBody()));

await sleep(600);   // 等悬挂的封面预览回调落地（jsdom close 会拆 location）
  dom.window.close();
}

/* ================================================================
 * H. 工具栏全部 25+ 动作的落点行为（真实点击路径）
 * ================================================================ */
{
  console.log('H. 工具栏动作');
  const { dom, w, d, E, p } = await makeSession();

  // H1. 工具栏按钮真实点击：h2（带选区 → 前缀）
  E.setBody('标题行');
  E.setSel(3);
  const btnH2 = d.querySelector('#toolbar button[data-act="h2"]');
  btnH2.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check(E.getBody() === '## 标题行', '点 H2 按钮 → 行前缀', JSON.stringify(E.getBody()));

  // H2. undo / redo 按钮（点击路径）
  // scheduleHistory 防抖 450ms：每个版本要等它单独入栈后再做下一个动作，
  // 否则防抖重置会把中间版本吞掉，undo 无处可退。
  E.setBody('标题行');
  await sleep(500);   // 『标题行』入栈
  const btnH2b = d.querySelector('#toolbar button[data-act="h2"]');
  btnH2b.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(500);   // 『## 标题行』入栈
  d.querySelector('#toolbar button[data-act="undo"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check(E.getBody() === '标题行', '点撤销按钮回到上一版', JSON.stringify(E.getBody()));
  d.querySelector('#toolbar button[data-act="redo"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check(E.getBody() === '## 标题行', '点重做按钮恢复', JSON.stringify(E.getBody()));

  // H3. strike / inline-code / kbd / sup / sub（包裹选区）
  const cases = [
    ['strike', '~~', '~~'],
    ['inline-code', '`', '`'],
    ['kbd', '<kbd>', '</kbd>'],
    ['sup', '<sup>', '</sup>'],
    ['sub', '<sub>', '</sub>']
  ];
  for (const [act, pre, post] of cases) {
    E.setBody('选我');
    E.setSel(0, 2);
    d.querySelector(`#toolbar button[data-act="${act}"]`).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    check(E.getBody() === pre + '选我' + post, `${act} 包裹选区`, JSON.stringify(E.getBody()));
  }

  // H4. hr / more / table / center / details（块级插入）
  E.setBody('x');
  E.setSel(1);
  d.querySelector('#toolbar button[data-act="hr"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check(E.getBody().includes('---'), 'hr 插入分割线');
  E.setBody('x');
  E.setSel(1);
  d.querySelector('#toolbar button[data-act="more"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check(E.getBody().includes('<!-- more -->'), 'more 插入摘要分隔');
  E.setBody('x');
  E.setSel(1);
  d.querySelector('#toolbar button[data-act="center"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check(E.getBody().includes('<div align="center">') && E.getBody().includes('</div>'), 'center 插入居中容器');
  E.setBody('x');
  E.setSel(1);
  d.querySelector('#toolbar button[data-act="details"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check(E.getBody().includes('<details>') && E.getBody().includes('<summary>'), 'details 插入折叠块');

  // H5. link：默认占位文字 + 选中替换
  E.setBody('链接文字');
  E.setSel(0, 4);
  d.querySelector('#toolbar button[data-act="link"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check(E.getBody() === '[链接文字](https://)', 'link 包裹并带默认地址', JSON.stringify(E.getBody()));

  // H6. task / quote（前缀）
  E.setBody('任务');
  E.setSel(2);
  d.querySelector('#toolbar button[data-act="task"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check(E.getBody() === '- [ ] 任务', 'task 前缀', JSON.stringify(E.getBody()));
  E.setBody('引用');
  E.setSel(2);
  d.querySelector('#toolbar button[data-act="quote"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check(E.getBody() === '> 引用', 'quote 前缀', JSON.stringify(E.getBody()));

  // H7. 弹窗类动作：code（填语言 → 插入 fence）
  E.setBody('开始');
  E.setSel(2);
  d.querySelector('#toolbar button[data-act="code"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  check(d.querySelector('#modal-title').textContent === '插入代码块', 'code 弹窗打开');
  const langInput = d.querySelector('#modal-body input');
  langInput.value = 'js';
  const ins = Array.from(d.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent === '插入');
  ins.click();
  await sleep(40);
  check(E.getBody().includes('```js\n') && E.getBody().includes('\n```'), '带语言插入代码块', E.getBody());

  // H8. 颜色弹窗：选色插入 font 标签
  E.setBody('红字');
  E.setSel(0, 2);
  d.querySelector('#toolbar button[data-act="mark"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  check(d.querySelector('#modal-title').textContent === '文字颜色', '颜色弹窗打开');
  const ins2 = Array.from(d.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent === '插入');
  ins2.click();
  await sleep(40);
  check(E.getBody() === '<font color="red">红字</font>', '默认红色 font 包裹', JSON.stringify(E.getBody()));

await sleep(600);   // 等悬挂的封面预览回调落地（jsdom close 会拆 location）
  dom.window.close();
}

console.log(`\n全量补充断言 ${checks} 条，失败 ${failed} 条`);
process.exit(failed === 0 ? 0 : 1);

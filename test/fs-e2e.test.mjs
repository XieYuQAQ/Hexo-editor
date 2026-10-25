// 端到端写盘测试：用内存里的假 File System Access API 模拟真实浏览器，
// 验证「打开目录 → 选文章 → 改字段 → 保存 → 文件内容变化」整条链路。
// 用法：node hexo-editor/test/fs-e2e.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('D:/ZEROKAMI/node_modules/jsdom');

const here = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.resolve(here, '..');
const postsDir = path.resolve(here, '../../source/_posts');

// 第 8 / 10 组用到的两篇最小样例（占位 abbrlink 用纯字母，避免被当成时间戳之类）
const sampleA = [
  '---',
  'title: 样例甲',
  'abbrlink: aaaaaaaa',
  'description: 样例甲摘要',
  'tags: [测试]',
  'date: 2026-01-01 00:00:00',
  'cover:',
  '---',
  '正文甲'
].join('\n');
const sampleB = [
  '---',
  'title: 样例乙',
  'abbrlink: bbbbbbbb',
  'description: 样例乙摘要',
  'tags: [测试]',
  'date: 2026-01-02 00:00:00',
  'cover:',
  '---',
  '正文乙'
].join('\n');

let checks = 0;
let failed = 0;
function check(ok, label, extra) {
  checks += 1;
  if (!ok) {
    failed += 1;
    console.log(`✗ ${label}` + (extra ? `\n    ${extra}` : ''));
  }
}

/* ================================================================
 * 内存版 File System Access：只实现编辑器用到的那几个 API
 * ================================================================ */
class FakeFileHandle {
  constructor(name, store) { this.kind = 'file'; this.name = name; this._store = store; }
  async getFile() {
    if (!this._store.has(this.name)) throw new Error('NotFoundError');
    const text = this._store.get(this.name);
    return {
      text: async () => text,
      lastModified: 1700000000000
    };
  }
  async createWritable() {
    const store = this._store;
    const name = this.name;
    return {
      async write(data) {
        // 真实 API 接受字符串 / Blob / BufferSource；这里两种都支持
        let text;
        if (typeof data === 'string') text = data;
        else if (data && typeof data.text === 'function') text = await data.text();
        else if (data && data._text != null) text = data._text;
        else text = '';
        store.set(name, text);
      },
      async close() {}
    };
  }
}

class FakeDirHandle {
  constructor(name, map = new Map()) {
    this.kind = 'directory';
    this.name = name;
    this._files = map;      // name -> text
    this._dirs = new Map(); // name -> FakeDirHandle
  }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
  async *values() {
    for (const [name, dir] of this._dirs) yield dir;
    for (const name of this._files.keys()) yield new FakeFileHandle(name, this._files);
  }
  async getDirectoryHandle(name, opts) {
    if (this._dirs.has(name)) return this._dirs.get(name);
    if (opts && opts.create) {
      const d = new FakeDirHandle(name);
      this._dirs.set(name, d);
      return d;
    }
    throw new Error('NotFoundError: ' + name);
  }
  async getFileHandle(name, opts) {
    if (this._files.has(name)) return new FakeFileHandle(name, this._files);
    if (opts && opts.create) {
      this._files.set(name, '');
      return new FakeFileHandle(name, this._files);
    }
    throw new Error('NotFoundError: ' + name);
  }
  async removeEntry(name) {
    if (this._files.delete(name)) return;
    if (this._dirs.delete(name)) return;
    throw new Error('NotFoundError');
  }
}

function buildFakeProject() {
  const root = new FakeDirHandle('ZEROKAMI');
  const source = new FakeDirHandle('source');
  const posts = new FakeDirHandle('_posts');
  const images = new FakeDirHandle('images');
  root._dirs.set('source', source);
  source._dirs.set('_posts', posts);
  source._dirs.set('images', images);
  return { root, source, posts, images };
}

/* ================================================================
 * 启动
 * ================================================================ */
const html = fs.readFileSync(path.join(editorDir, 'index.html'), 'utf8')
  .replace(/<script src="assets\/[^"]+"><\/script>/g, '');
const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const w = dom.window;
const d = w.document;
if (!w.URL.createObjectURL) w.URL.createObjectURL = () => 'blob:mock';
if (!w.URL.revokeObjectURL) w.URL.revokeObjectURL = () => {};
w.indexedDB = undefined;

for (const file of ['core.js', 'app.js']) {
  w.eval(fs.readFileSync(path.join(editorDir, 'assets', file), 'utf8'));
}
d.dispatchEvent(new w.Event('DOMContentLoaded'));

const E = w.HexoEditor;
const Core = w.HexoCore;

/* ================================================================
 * 1. 目录自动识别：项目根 → source/_posts
 * ================================================================ */
const proj = buildFakeProject();
proj.posts._files.set('25 迈从G3 A鼠标开箱.md', fs.readFileSync(path.join(postsDir, '25 迈从G3 A鼠标开箱.md'), 'utf8'));
proj.posts._files.set('26 半高SATA硬盘盒开箱.md', fs.readFileSync(path.join(postsDir, '26 半高SATA硬盘盒开箱.md'), 'utf8'));

await E.fs.attach(proj.root);
check(E.state.mode === 'fs', '进入 fs 模式');
check(E.state.posts.length === 2, '读到 2 篇文章', E.state.posts.length);
check(E.state.hasImages === true, '识别到 images 目录');
check(d.querySelector('#dot-posts').classList.contains('on'), '文章目录圆点变绿');
check(d.querySelector('#dot-images').classList.contains('on'), '图片目录圆点变绿');
check(d.querySelector('#dot-posts').title.includes('ZEROKAMI'), '圆点提示里带目录名', d.querySelector('#dot-posts').title);
// 连接后不自动打开文章：右侧应是灰掉的空编辑器
check(!!E.state.current === false, '连接目录后不自动选中文章');
check(!d.querySelector('#editor').classList.contains('hidden'), '编辑区已显示');
check(d.querySelector('#editor').classList.contains('idle'), '编辑区为灰色不可用态');
check(!d.querySelector('#idle-hint').classList.contains('hidden'), '显示「还没有选择文章」提示');
check(d.querySelector('#btn-toggle-sidebar').classList.contains('hidden'), '没选文章时不显示收起按钮');
check(!d.querySelector('#app').classList.contains('collapsed'), '没选文章时列表不收起');

/* ================================================================
 * 2. 打开文章 → 改字段 → 保存回假磁盘
 * ================================================================ */
const p = E.state.posts.find((x) => x.name.includes('迈从G3'));
check(!!p, '找到目标文章');
E.openPost(p, { skipDraftCheck: true });

const titleInput = d.querySelector('#f-title');
titleInput.value = '迈从G3 A鼠标开箱（E2E）';
titleInput.dispatchEvent(new w.Event('input', { bubbles: true }));
check(p.dirty === true, '改标题后 dirty');

const coverInput = d.querySelector('#f-cover');
coverInput.value = '/images/2025/09/new-cover.jpg';
coverInput.dispatchEvent(new w.Event('input', { bubbles: true }));

E.addTag('端到端');

await E.savePost({ force: true });

const saved = proj.posts._files.get('25 迈从G3 A鼠标开箱.md');
check(!!saved, '文件已写回');
check(saved.includes('title: 迈从G3 A鼠标开箱（E2E）'), '磁盘上标题已更新');
check(saved.includes('cover: /images/2025/09/new-cover.jpg'), '磁盘上封面已更新');
check(saved.includes('端到端'), '磁盘上标签已更新');

/* 其它字段必须保持原样 */
const original = fs.readFileSync(path.join(postsDir, '25 迈从G3 A鼠标开箱.md'), 'utf8');
const origFm = Core.splitFront(original).front.filter((l) => /^(abbrlink|date):/.test(l));
const newFm = Core.splitFront(saved).front.filter((l) => /^(abbrlink|date):/.test(l));
check(JSON.stringify(origFm) === JSON.stringify(newFm), 'abbrlink / date 未被改动', newFm.join(' | '));
check(Core.splitFront(saved).body === Core.splitFront(original).body, '正文逐字节未变');

/* 保存后状态 */
check(p.dirty === false, '保存后 dirty 清除');
check(d.querySelector('#save-state').textContent === '已保存', '状态栏已保存');

/* ================================================================
 * 3. 保存后日期解锁
 * ================================================================ */
check(d.querySelector('#f-date').disabled === false, '保存后日期可编辑');
const dateInput = d.querySelector('#f-date');
dateInput.value = '2025-09-29 08:30:00';
dateInput.dispatchEvent(new w.Event('input', { bubbles: true }));
await E.savePost({ force: true });
const saved2 = proj.posts._files.get('25 迈从G3 A鼠标开箱.md');
check(saved2.includes('date: 2025-09-29 08:30:00'), '日期修改已落盘', saved2.split('\n').find((l) => l.startsWith('date:')));

/* ================================================================
 * 4. 新建文章 → 写盘 → abbrlink 为空等待 generate
 * ================================================================ */
const newDoc = Core.createPost({ title: '端到端新建', tags: ['测试'] });
const newText = Core.stringifyPost(newDoc);
proj.posts._files.set('26 端到端新建.md', newText);
await E.fs.loadAll();
check(E.state.posts.length === 3, '新增后 3 篇', E.state.posts.length);

const np = E.state.posts.find((x) => x.name === '26 端到端新建.md');
check(!!np, '读到新文章');
check(String(Core.get(np.doc, 'abbrlink')) === '', '新文章 abbrlink 为空');

E.openPost(np, { skipDraftCheck: true });
check(d.querySelector('#f-abbrlink').disabled === true, 'abbrlink 保持锁定（新文章）');
check(d.querySelector('#lock-abbrlink').textContent === '🔒', '锁图标为锁定');

/* ================================================================
 * 5. 改文件名保存：旧文件清理确认框（点「删除旧文件」）
 * ================================================================ */
const nameInput = d.querySelector('#file-name');
nameInput.value = '26 端到端新建 改名.md';
nameInput.dispatchEvent(new w.Event('change', { bubbles: true }));

const savePromise = E.savePost({ force: true });
await new Promise((r) => setTimeout(r, 60));
const renameModal = d.querySelector('#modal');
check(!renameModal.classList.contains('hidden'), '改名后弹出旧文件处理确认');
const delOldBtn = Array.from(renameModal.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent === '删除旧文件');
check(!!delOldBtn, '确认框含「删除旧文件」');
delOldBtn.click();
await savePromise;
await new Promise((r) => setTimeout(r, 60));

check(proj.posts._files.has('26 端到端新建 改名.md'), '按新文件名写入', [...proj.posts._files.keys()].join(' | '));
check(!proj.posts._files.has('26 端到端新建.md'), '旧文件已删除');

/* ================================================================
 * 6. 删除文章
 * ================================================================ */
const beforeCount = proj.posts._files.size;
d.querySelector('#btn-delete').click();
await new Promise((r) => setTimeout(r, 30));
const modal = d.querySelector('#modal');
check(!modal.classList.contains('hidden'), '删除确认框弹出');
const btn = Array.from(modal.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent === '删除');
btn.click();
await new Promise((r) => setTimeout(r, 120));
check(proj.posts._files.size === beforeCount - 1, '磁盘文件已删除', `${beforeCount} -> ${proj.posts._files.size}`);
check(!proj.posts._files.has('26 端到端新建 改名.md'), '指定文件被删掉');

/* ================================================================
 * 7. 图片写入 source/images/YYYY/MM/
 * ================================================================ */
const fakeImage = {
  name: 'my-photo with 中文 & spaces.PNG',
  type: 'image/png',
  text: async () => '',
  arrayBuffer: async () => new ArrayBuffer(4)
};
const imgPath = await E.fs.saveImage(fakeImage, new Date(2026, 0, 15));
check(/^\/images\/2026\/01\/[a-z0-9]{10}\.PNG$/.test(imgPath), '图片名 = 10 位随机字母数字 + 原后缀', imgPath);
const year = proj.images._dirs.get('2026');
check(!!year, '创建了年份目录');
check(year._dirs.has('01'), '创建了月份目录');

// 同一张图再存一次：名字随机，不会重名/覆盖
const again = await E.fs.saveImage(fakeImage, new Date(2026, 0, 15));
check(again !== imgPath, '再次上传取到不同的随机名', again);
check(/^\/images\/2026\/01\/[a-z0-9]{10}\.PNG$/.test(again), '第二次名字同样符合规则', again);
check(proj.images._dirs.get('2026')._dirs.get('01')._files.size === 2, '两张图都落盘了');

/* ================================================================
 * 8. 只连 _posts 时：应提示「没找到 source/images」并给出可点击的连接入口
 * ================================================================ */
{
  const proj2 = buildFakeProject();
  proj2.posts._files.set('A.md', sampleA);
  // 注意：这里直接把 _posts 当根目录传进去，模拟用户只选了 _posts
  E.state.imagesDir = null;
  E.state.hasImages = false;
  await E.fs.attach(proj2.posts);
  E.updateModeUI();

  check(E.state.mode === 'fs', '只选 _posts 也能进入 fs 模式');
  check(E.state.posts.length === 1, '只选 _posts 能读到文章', E.state.posts.length);
  check(E.state.hasImages === false, '此时没有 images');

  check(d.querySelector('#dot-posts').classList.contains('on'), '文章目录圆点仍为绿');
  check(!d.querySelector('#dot-images').classList.contains('on'), '缺 images 时图片圆点为红');
  check(d.querySelector('#dot-images').title.includes('未连接'), '图片圆点提示未连接', d.querySelector('#dot-images').title);
  check(E.dirsReady() === false, '缺图片目录时 dirsReady 为 false');
}

/* ================================================================
 * 9. 单独连接图片目录：选 images 本身 / 选 source / 选项目根都能识别
 * ================================================================ */
{
  // 9a. 选中的就是 images
  const imgDir = new FakeDirHandle('images');
  w.showDirectoryPicker = async () => imgDir;
  let ok = await E.fs.pickImages();
  check(ok === true, '选中 images 目录成功');
  check(E.state.hasImages === true, 'hasImages 变为 true');
  check(E.state.imagesDir.name === 'images', 'imagesDir 指向 images');

  // 9b. 选中的是 source（含 images 子目录）
  E.state.imagesDir = null;
  E.state.hasImages = false;
  const srcDir = new FakeDirHandle('source');
  srcDir._dirs.set('images', new FakeDirHandle('images'));
  w.showDirectoryPicker = async () => srcDir;
  ok = await E.fs.pickImages();
  check(ok === true, '选中 source 也能找到 images');
  check(E.state.imagesDir.name === 'images', 'imagesDir 正确');

  // 9c. 选中的是项目根
  E.state.imagesDir = null;
  E.state.hasImages = false;
  const rootDir = new FakeDirHandle('ZEROKAMI');
  const src2 = new FakeDirHandle('source');
  src2._dirs.set('images', new FakeDirHandle('images'));
  rootDir._dirs.set('source', src2);
  w.showDirectoryPicker = async () => rootDir;
  ok = await E.fs.pickImages();
  check(ok === true, '选中项目根也能找到 images');

  // 9d. 选错目录（没有 images）应拒绝
  E.state.imagesDir = null;
  E.state.hasImages = false;
  const wrong = new FakeDirHandle('随便一个目录');
  w.showDirectoryPicker = async () => wrong;
  ok = await E.fs.pickImages();
  check(ok === false, '选错目录时拒绝');
  check(E.state.hasImages === false, '选错时状态不变');
}

/* ================================================================
 * 10. 已有 images 时，重新 attach 文章目录不应把图片连接冲掉
 * ================================================================ */
{
  const proj3 = buildFakeProject();
  proj3.posts._files.set('B.md', sampleB);
  E.state.imagesDir = new FakeDirHandle('images');
  E.state.hasImages = true;
  await E.fs.attach(proj3.posts);
  check(E.state.hasImages === true, '重新打开文章目录后图片连接保留');
  check(E.state.imagesDir.name === 'images', 'imagesDir 未被覆盖');
}

/* ================================================================
 * 11. 目录连接引导 + 底部状态圆点（记住的目录需重新授权 → 一键恢复）
 * ================================================================ */
{
  const dp = d.querySelector('#dot-posts');
  const di = d.querySelector('#dot-images');

  // 造一个「记得住但这次还没授权」的目录（模拟浏览器重启后的状态）
  const proj4 = buildFakeProject();
  const root4 = proj4.root;
  root4._granted = false;
  root4.queryPermission = async () => (root4._granted ? 'granted' : 'prompt');
  root4.requestPermission = async () => { root4._granted = true; return 'granted'; };

  E.state.mode = 'demo';
  E.state.postsDir = null;
  E.state.rootRemembered = root4;
  E.state.imagesDir = null;
  E.state.hasImages = false;
  E.state.imagesRemembered = null;
  E.updateModeUI();

  check(!dp.classList.contains('on'), '未连接时文章目录圆点为红');
  check(!di.classList.contains('on'), '未连接时图片目录圆点为红');
  check(dp.title.includes('重新授权'), '记住但未授权时圆点提示重新授权', dp.title);

  E.openDirGuide();
  check(!d.querySelector('#modal').classList.contains('hidden'), '引导弹窗已打开');
  check(d.querySelectorAll('#modal .guide-row').length === 2, '引导里两行：文章目录 / 图片目录');
  const guideTxt = d.querySelector('#modal').textContent;
  check(guideTxt.includes('文章目录') && guideTxt.includes('图片目录'), '两行标题正确');
  check(guideTxt.includes('ZEROKAMI'), '显示记住的目录名', guideTxt.slice(0, 60));
  const grantBtn = Array.from(d.querySelectorAll('#modal .guide-row button')).find((x) => x.textContent === '重新授权');
  check(!!grantBtn, '记住的目录给出「重新授权」按钮');

  // 点重新授权 → requestPermission 通过 → 直接接回文章目录
  grantBtn.click();
  await new Promise((r) => setTimeout(r, 30));

  check(root4._granted === true, '点击后向浏览器申请了写入权限');
  check(E.state.mode === 'fs', '授权后进入 fs 模式', E.state.mode);
  check(dp.classList.contains('on'), '授权后文章目录圆点转绿');
  check(E.state.rootRemembered === null, '记住的目录已转为正式连接');
  check(E.state.hasImages === true && di.classList.contains('on'), '项目根里的 source/images 顺带连上，图片圆点也转绿');

  // 关掉弹窗（避免残留监听影响后续）
  d.querySelector('#modal-foot .btn.primary').click();
}

/* ================================================================
 * 12. 引导弹窗只在「没连全」时弹：两个目录都连好就不再打扰
 * ================================================================ */
{
  const modal = d.querySelector('#modal');
  check(E.dirsReady() === true, '文章目录 + 图片目录都连上时 dirsReady 为 true');

  modal.classList.add('hidden'); // 人为关掉，验证不会被重新弹出
  check(E.maybeOpenDirGuide() === false, '两个目录都连好：不弹引导');
  check(modal.classList.contains('hidden'), '此时弹窗保持关闭');

  // 图片目录掉了 → 应该自动弹
  E.state.imagesDir = null;
  E.state.hasImages = false;
  check(E.dirsReady() === false, '图片目录断开后 dirsReady 为 false');
  check(E.maybeOpenDirGuide() === true, '缺图片目录：自动弹引导');
  check(!modal.classList.contains('hidden'), '引导已打开');
  d.querySelector('#modal-foot .btn.primary').click();
}

/* ================================================================
 * 13. 打开文章后侧栏收起；关闭文章后恢复展开
 * ================================================================ */
{
  const app = d.querySelector('#app');
  const toggle = d.querySelector('#btn-toggle-sidebar');

  E.state.mode = 'fs';
  E.state.postsDir = { name: '_posts' };
  E.state.imagesDir = { name: 'images' };
  E.state.hasImages = true;
  E.state.current = null;
  E.state.sidebarCollapsed = false;
  E.updateModeUI();

  check(!app.classList.contains('collapsed'), '没选文章时列表展开');
  check(toggle.classList.contains('hidden'), '没选文章时不显示收起按钮');

  E.loadFromText('27 侧栏测试.md', '---\ntitle: 侧栏\ndate: 2026-10-26 10:00:00\n---\n正文');
  check(E.state.current !== null, '已打开一篇文章');
  check(app.classList.contains('collapsed'), '打开文章后列表自动收起');
  check(!toggle.classList.contains('hidden'), '打开文章后出现收起/展开按钮');
  check(!d.querySelector('#editor').classList.contains('idle'), '编辑区不再是灰色');

  E.toggleSidebar();
  check(!app.classList.contains('collapsed'), '点按钮后列表弹出来');
  E.toggleSidebar();
  check(app.classList.contains('collapsed'), '再点一次又收起');

  E.closeEditor();
  check(!app.classList.contains('collapsed'), '关闭文章后列表恢复展开');
  check(d.querySelector('#editor').classList.contains('idle'), '关闭文章后编辑区变灰');
  check(!d.querySelector('#idle-hint').classList.contains('hidden'), '关闭文章后显示空态提示');
  check(toggle.classList.contains('hidden'), '关闭文章后收起按钮消失');
}

/* ================================================================
 * 14. 主题三档：白天 / 黑夜 / 自动（跟随系统）
 * ================================================================ */
{
  const html = d.documentElement;
  check(E.setTheme('light') === 'light', '切到白天模式');
  check(html.getAttribute('data-theme') === 'light', 'html[data-theme=light]');
  // jsdom 不解析 CSS 变量，主题色表用静态检查兜底（真实渲染在浏览器里截图验过）
  const cssText = fs.readFileSync(path.join(editorDir, 'assets/editor.css'), 'utf8');
  check(/html\[data-theme="light"\]\s*\{[^}]*--bg:\s*#f5f6f9/.test(cssText), '白天色表存在（--bg: #f5f6f9）');

  check(E.setTheme('dark') === 'dark', '切到黑夜模式');
  check(html.getAttribute('data-theme') === 'dark', 'html[data-theme=dark]');
  check(/^:root\s*\{[^}]*--bg:\s*#0f1115/m.test(cssText), '黑夜色表存在（--bg: #0f1115）');

  check(E.themeMode() === 'dark', '选择被记住（localStorage）', E.themeMode());
  check(d.querySelector('#theme-switch button[data-theme="dark"]').classList.contains('on'), '黑夜按钮高亮');
  check(!d.querySelector('#theme-switch button[data-theme="light"]').classList.contains('on'), '白天按钮取消高亮');

  // auto：跟随系统（jsdom 的 matchMedia 恒为 false → 落在白天）
  const eff = E.setTheme('auto');
  check(E.themeMode() === 'auto', '切回自动');
  check(eff === 'light', '自动模式下按系统偏好解析（此处系统=浅色）', eff);
  check(html.getAttribute('data-theme') === 'light', '自动模式实际落到浅色');
  E.setTheme('dark'); // 还原，避免影响后续
}

dom.window.close();
console.log(`\n端到端断言 ${checks} 条，失败 ${failed} 条`);
process.exit(failed === 0 ? 0 : 1);

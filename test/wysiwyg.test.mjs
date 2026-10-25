// 所见即所得编辑层：正文 DOM 往返必须逐字节不变 + 块级识别 + 回车/退格/撤销
// 用法：node hexo-editor/test/wysiwyg.test.mjs
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

/* ---------------- 启动 DOM ---------------- */
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
for (const f of ['core.js', 'app.js']) {
  w.eval(fs.readFileSync(path.join(editorDir, 'assets', f), 'utf8'));
}
d.dispatchEvent(new w.Event('DOMContentLoaded'));

const E = w.HexoEditor;
const Core = w.HexoCore;
const bodyEl = d.querySelector('#body');

/* ================================================================
 * 1. 全站 90 篇：正文进 DOM 再读回来，必须逐字节一致
 * ================================================================ */
{
  const files = fs.readdirSync(postsDir).filter((f) => f.endsWith('.md'));
  const bad = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(postsDir, f), 'utf8');
    const body = Core.splitFront(raw).body;
    E.loadFromText(f, raw, {});
    E.setBody(body);
    if (E.getBody() !== body) bad.push(f);
  }
  check(bad.length === 0, `${files.length} 篇正文「文本 → DOM → 文本」逐字节一致`, bad.slice(0, 3).join(' / '));
}

/* ================================================================
 * 2. 块级识别
 * ================================================================ */
{
  E.setBody([
    '# 一级', '###### 六级', '> 引用', '- 列表', '1. 有序', '- [ ] 待办', '- [x] 完成',
    '```js', 'const a = 1;', '```', '---', '| a | b |', '<div>x</div>', '普通段落'
  ].join('\n'));
  const want = ['h1', 'h6', 'quote', 'ul', 'ol', 'task', 'task-done',
    'fence', 'code', 'fence', 'hr', 'table', 'html', 'p'];
  const got = E.lineTypes();
  check(JSON.stringify(got) === JSON.stringify(want), '行类型识别正确', got.join(','));
  check(E.getBody().includes('# 一级') && E.getBody().includes('| a | b |'), '识别过程中文本没有被改动');
}

/* ================================================================
 * 3. 渲染态：标记隐藏但 textContent 仍完整
 * ================================================================ */
{
  E.setBody('## 小标题\n正常的 **粗体** 和 `代码` 以及 [链接](https://a.b)\n末行');
  const before = E.getBody();
  E.setSel(before.length);              // 光标移到第二行 → 第一行进入渲染态
  const lines = bodyEl.children;
  const h = lines[0];
  check(h.getAttribute('data-t') === 'h2', '第一行是 h2');
  check(!!h.querySelector('[data-i="mk"]'), '渲染态下 # 标记被包进隐藏 span');
  check(h.querySelector('[data-i="mk"]').textContent === '## ', '隐藏 span 里就是原始标记');
  check(h.textContent === '## 小标题', '渲染态 textContent 与原文一致');

  const l2 = lines[1];
  const spans = [...l2.querySelectorAll('[data-i]')].map((s) => s.getAttribute('data-i')).join(',');
  check(spans.includes('b') && spans.includes('code') && spans.includes('a'), '行内格式被识别', spans);
  check(l2.textContent === '正常的 **粗体** 和 `代码` 以及 [链接](https://a.b)', '行内渲染不丢字符', l2.textContent);
  check(E.getBody() === before, '整篇文本仍然一致');
}

/* ================================================================
 * 4. 光标所在行保持原始 markdown
 * ================================================================ */
{
  E.setBody('### 标题');
  E.setSel(0);                          // 光标在第一行
  const line = bodyEl.children[0];
  check(line.classList.contains('editing'), '光标行标记为 editing');
  check(!line.querySelector('[data-i="mk"]'), '光标行不出隐藏标记（显示原始 ###）');
  check(E.lineTypes()[0] === 'h3', '光标行照样是 h3 样式（字号立刻变大）');
}

/* ================================================================
 * 5. 回车 / 退格 / 删除
 * ================================================================ */
function key(k) {
  bodyEl.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}
{
  E.setBody('- 甲');
  E.setSel(3);
  key('Enter');
  check(E.getBody() === '- 甲\n- ', '列表里回车自动续 "- "', JSON.stringify(E.getBody()));

  E.setBody('- ');
  E.setSel(2);
  key('Enter');
  check(E.getBody() === '', '空列表项回车 = 退出列表', JSON.stringify(E.getBody()));

  E.setBody('1. 甲');
  E.setSel(4);
  key('Enter');
  check(E.getBody() === '1. 甲\n2. ', '有序列表序号自动 +1', JSON.stringify(E.getBody()));

  E.setBody('> 引用');
  E.setSel(4);
  key('Enter');
  check(E.getBody() === '> 引用\n> ', '引用里回车续 "> "', JSON.stringify(E.getBody()));

  E.setBody('甲乙\n丙丁');
  E.setSel(3);                          // 第二行行首
  key('Backspace');
  check(E.getBody() === '甲乙丙丁', '行首退格合并上一行', JSON.stringify(E.getBody()));

  E.setBody('甲乙\n丙丁');
  E.setSel(2);                          // 第一行行尾
  key('Delete');
  check(E.getBody() === '甲乙丙丁', '行尾 Delete 合并下一行', JSON.stringify(E.getBody()));
}

/* ================================================================
 * 6. 撤销 / 重做
 * ================================================================ */
{
  E.setBody('第一版');
  E.historyPush();
  E.setBody('第二版');
  E.historyPush();
  check(E.getBody() === '第二版', '准备两版');
  E.undo();
  check(E.getBody() === '第一版', '撤销回到上一版', JSON.stringify(E.getBody()));
  E.redo();
  check(E.getBody() === '第二版', '重做回到最新版', JSON.stringify(E.getBody()));
}

/* ================================================================
 * 7. 保存路径：改一个字后存出来，只有那一处变化
 * ================================================================ */
{
  const raw = fs.readFileSync(path.join(postsDir, '26 半高SATA硬盘盒开箱.md'), 'utf8');
  E.loadFromText('26 半高SATA硬盘盒开箱.md', raw, {});
  E.setBody(E.getBody() + '\n\n新增一行');
  const out = E.currentText();
  check(out.startsWith(raw), '改动后 front matter 与原文逐字节相同');
  check(out.endsWith('新增一行'), '新增内容在末尾');
  check(Core.parsePost(out).body === Core.parsePost(raw).body + '\n\n新增一行', '正文只多出新增的那一行');
}

/* ================================================================
 * 8. 兜底：某一行里被塞进换行 → 自动按行重排
 * ================================================================ */
{
  E.setBody('甲\n乙');
  bodyEl.children[0].textContent = '甲\n丙';       // 模拟粘贴/输入法把 \n 塞进一行
  bodyEl.dispatchEvent(new w.Event('input', { bubbles: true }));
  check(E.getBody() === '甲\n丙\n乙', '行内换行被拆回独立的一行', JSON.stringify(E.getBody()));
  check(bodyEl.children.length === 3, 'DOM 行数跟着重排', bodyEl.children.length);
}

/* ================================================================
 * 9. 表格：连续 | a | b | 行拼成一张表（文字由 ::before attr() 画，不动 textContent）
 * ================================================================ */
{
  E.setBody('| 产品 | 价格 | 备注 |\n|:---|---:|:---:|\n| 甲 | 100 | 现货 |\n| 乙 | 200 | 预定 |\n表格结束');
  E.setSel(E.getBody().length);
  const L = bodyEl.children;

  check(L[0].getAttribute('data-t') === 'table', '第一行识别为表格');
  check(L[0].getAttribute('data-head') === '1', '首行标记为表头');
  check(L[1].getAttribute('data-sep') === '1', '第二行是分隔行');
  check(L[2].getAttribute('data-head') === null, '数据行不是表头');

  const cells = [...L[0].querySelectorAll('.tc')];
  check(cells.length === 3, '表头渲染出 3 个单元格', cells.length);
  check(cells.map((c) => c.getAttribute('data-c')).join('|') === '产品|价格|备注', '单元格文字进了 data-c', cells.map((c) => c.textContent).join(','));
  check(cells.every((c) => c.childNodes.length === 0), '单元格自身没有文本节点（不污染 textContent）');
  check(L[0].textContent === '| 产品 | 价格 | 备注 |', '表格行 textContent 仍是原始 markdown', JSON.stringify(L[0].textContent));
  check(L[0].style.getPropertyValue('--cols') === '3', '列数写进 --cols', L[0].style.getPropertyValue('--cols'));

  // 对齐：:--- 左（不设属性） / ---: 右 / :---: 居中
  check(cells[1].getAttribute('data-al') === 'right', '第二列右对齐');
  check(cells[2].getAttribute('data-al') === 'center', '第三列居中');
  check(!cells[0].getAttribute('data-al'), '左对齐不设 data-al');

  // 单元格记录的起始偏移要能指回原文
  const at = Number(cells[1].getAttribute('data-at'));
  check(L[0].textContent.slice(at, at + 2) === '价格', 'data-at 指向该单元格在原文里的位置', JSON.stringify(L[0].textContent.slice(at, at + 6)));

  check(E.getBody().includes('| 甲 | 100 | 现货 |'), '渲染后整篇 markdown 不变');
}

/* ================================================================
 * 10. 表格：列数不齐的行按整块最大列数对齐
 * ================================================================ */
{
  E.setBody('| a | b |\n|---|---|\n| c | d | e |\n尾行');
  E.setSel(E.getBody().length);
  const L = bodyEl.children;
  const cols = [...L].slice(0, 3).map((l) => l.style.getPropertyValue('--cols'));
  check(cols.join(',') === '3,3,3', '同一表格块的列数统一取最大值', cols.join(','));
}

/* ================================================================
 * 11. 点单元格 → 光标精确落到那个单元格的文字上（不是行首）
 * ================================================================ */
{
  E.setBody('| 甲 | 乙 |\n下面');
  E.setSel(E.getBody().length);
  const row = bodyEl.children[0];
  check(!row.classList.contains('editing'), '点之前是渲染态');
  const cell = row.querySelectorAll('.tc')[1];
  cell.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  check(row.classList.contains('editing'), '点单元格后该行切回源码态');
  check(row.textContent === '| 甲 | 乙 |', '切回源码态后显示原始 markdown');
}

/* ================================================================
 * 12. 图片：真图预览 + 不影响 textContent
 * ================================================================ */
{
  E.setBody('![](/images/2026/10/a1b2c3d4e5.png)\n下一行');
  E.setSel(E.getBody().length);
  const row = bodyEl.children[0];
  const img = row.querySelector('img.ed-img');
  check(!!img, '渲染出真 <img> 元素');
  check(img.getAttribute('data-src') === '/images/2026/10/a1b2c3d4e5.png', 'src 取自 markdown 路径', img && img.getAttribute('data-src'));
  check(row.classList.contains('img-only'), '整行只有一张图 → 走大图预览');
  check(row.textContent === '![](/images/2026/10/a1b2c3d4e5.png)', '<img> 的 textContent 为空，读回不丢字符', JSON.stringify(row.textContent));
  check(E.getBody() === '![](/images/2026/10/a1b2c3d4e5.png)\n下一行', '整篇 markdown 不变');
}

/* ================================================================
 * 13. 图片：夹在文字中间时是小缩略图
 * ================================================================ */
{
  E.setBody('看图 ![](/images/a.png) 结束\n下一行');
  E.setSel(E.getBody().length);
  const row = bodyEl.children[0];
  check(!!row.querySelector('img.ed-img'), '行内图片也有缩略图');
  check(!row.classList.contains('img-only'), '行内图片不放大');
  check(row.textContent === '看图 ![](/images/a.png) 结束', '行内图片不丢字符', JSON.stringify(row.textContent));
}

/* ================================================================
 * 14. 插入表格 / 图片后光标落在块后面 → 立刻看得见渲染效果
 * ================================================================ */
{
  E.setBody('开头');
  E.setSel(2);
  E.action('table');
  const L = bodyEl.children;
  check(L[0].textContent === '开头', '原有文字留在第一行');
  check(L[1].getAttribute('data-t') === 'table', '插入的表格第一行是 table');
  check(!L[1].classList.contains('editing'), '光标不在表格里 → 整张表直接渲染');
  check(L[1].querySelectorAll('.tc').length === 3, '插入的表格渲染出 3 列');
  check(L[L.length - 1].classList.contains('editing'), '光标落在表格后面的空行', L.length);

  E.setBody('开头');
  E.setSel(2);
  E.insertBlock('![](/images/b.png)', true);
  check(bodyEl.children[1].classList.contains('img-only'), '插图后图片行立刻进入大图渲染');
  check(bodyEl.children[2].classList.contains('editing'), '光标被让到图片后面');
}

/* ================================================================
 * 15. 非折叠选区（拖选文字）不打断渲染态 —— 从下往上选也能正常
 * ================================================================ */
{
  E.setBody('行一\n行二\n行三');
  E.setSel(0);   // 光标在行一，行二、行三进入渲染态
  const L = bodyEl.children;
  check(!L[2].classList.contains('editing'), '行三初始为渲染态（非编辑）');

  // 模拟跨行拖选：setSel(7, 0) 产生非折叠选区（selInfo 归一化 a=0 b=7）。
  // 修复前 syncActiveLine 会把 activeLine 切到 info.a 所在行并重建 textContent，
  // 打断拖选；修复后非折叠选区直接 return，不碰 DOM。
  E.setSel(7, 0);
  check(!L[2].classList.contains('editing'), '非折叠选区期间行三不被切回源码', L[2].className);
  check(L[2].textContent === '行三', '非折叠选区期间行三文本保持不变');
  check(L[1].textContent === '行二', '行二也不被重建');
}

/* ================================================================
 * 16. 视频块：识别 + iframe 预览 + 折叠/展开 + roundtrip 保持
 * ================================================================ */
{
  const block = Core.buildVideoBlock({ bvid: 'BV1CibC6BEdT', youtube: 'bI5YOkr5-Lc' });
  E.setBody('前面\n' + block + '\n后面');
  E.setSel(0);
  const L = bodyEl.children;
  const head = [...L].find((l) => l.hasAttribute('data-vhead'));
  check(!!head, '识别出视频块首行');
  const vblockLines = [...L].filter((l) => l.hasAttribute('data-vblock'));
  check(vblockLines.length >= 9, '块内所有行都有 data-vblock', vblockLines.length);

  // 折叠态：首行渲染 iframe，其余行靠 CSS 隐藏
  check(!bodyEl.classList.contains('vblock-open'), '折叠态：body 无 vblock-open');
  const iframe = head.querySelector('.ed-video iframe');
  check(!!iframe, '首行渲染出 iframe 预览');
  check(iframe.getAttribute('src') === 'https://player.bilibili.com/player.html?bvid=BV1CibC6BEdT&page=1&high_quality=1&danmaku=0',
    'iframe 指向 B 站播放器', iframe.getAttribute('src'));

  // roundtrip：渲染后 textContent 仍逐字节（iframe 的 textContent 为空串）
  check(E.getBody() === '前面\n' + block + '\n后面', '视频块 textContent 往返一致');

  // 光标进块 → 展开
  E.setSel(('前面\n').length);   // 落到首行开头（块内）
  check(bodyEl.classList.contains('vblock-open'), '光标进块 → vblock-open 展开');

  // 二选一形态（单行 iframe）也能识别 + 往返
  const single = Core.buildVideoBlock({ bvid: 'BV1CibC6BEdT', auto: false, style: 'simple' });
  E.setBody('开头\n' + single + '\n结尾');
  E.setSel(0);
  const L2 = bodyEl.children;
  const singleHead = [...L2].find((l) => l.hasAttribute('data-vhead'));
  check(!!singleHead, '二选一单行 iframe 也识别为视频块');
  check(singleHead.textContent === single, '二选一 textContent 不变');
  check(E.getBody() === '开头\n' + single + '\n结尾', '二选一 roundtrip 一致');
}

dom.window.close();
console.log(`\n所见即所得断言 ${checks} 条，失败 ${failed} 条`);
process.exit(failed === 0 ? 0 : 1);

import { findPostsDir, pickPost, waitForBoot } from './helpers.mjs';
// 编辑语义测试：改单个字段时，输出与原文的差异必须只落在该字段上
// 用法：node hexo-editor/test/edit.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const Core = require('../assets/core.js');

const here = path.dirname(fileURLToPath(import.meta.url));

const postsDir = findPostsDir(here);

let checks = 0;
let failed = 0;
function check(ok, label, extra) {
  checks += 1;
  if (!ok) {
    failed += 1;
    console.log(`✗ ${label}` + (extra ? `\n  ${extra}` : ''));
  }
}

function fmLines(text) {
  const s = Core.splitFront(text);
  return s.hasFront ? s.front : [];
}
function bodyOf(text) {
  return Core.splitFront(text).body;
}
function lineFor(text, key) {
  return fmLines(text).filter((l) => new RegExp('^' + key + ':').test(l));
}

/* ---------- 1. 改 title ---------- */
{
  const sample = pickPost(postsDir, null, '任意一篇文章');
  const raw = sample.raw;
  const doc = Core.parsePost(raw);
  Core.set(doc, 'title', '示例标题（改名测试）');
  const out = Core.stringifyPost(doc);
  check(lineFor(out, 'title').length === 1, 'title 只输出一行');
  check(lineFor(out, 'title')[0] === 'title: 示例标题（改名测试）', 'title 内容正确', lineFor(out, 'title')[0]);
  check(bodyOf(out) === bodyOf(raw), 'title 改动不影响正文');
  check(fmLines(out).length === fmLines(raw).length, 'title 改动不增减 front matter 行数');
  // 其它行逐行不变
  const a = fmLines(raw).filter((l) => !/^title:/.test(l));
  const b = fmLines(out).filter((l) => !/^title:/.test(l));
  check(JSON.stringify(a) === JSON.stringify(b), 'title 改动不影响其它字段行');
}

/* ---------- 2. 改 tags ---------- */
{
  const sample = pickPost(postsDir, (raw) => /^tags: \[[^\]]*\S[^\]]*\]/m.test(raw), '含内联标签的文章');
  const raw = sample.raw;
  const doc = Core.parsePost(raw);
  Core.set(doc, 'tags', ['硬件', '生活', 'DIY']);
  const out = Core.stringifyPost(doc);
  check(lineFor(out, 'tags')[0] === 'tags: [硬件, 生活, DIY]', 'tags 内联数组格式', lineFor(out, 'tags')[0]);
  const d2 = Core.parsePost(out);
  check(JSON.stringify(Core.get(d2, 'tags')) === JSON.stringify(['硬件', '生活', 'DIY']), 'tags 可回读');
}

/* ---------- 3. 改 description：单行 -> 多行 -> 单行 ---------- */
{
  const sample = pickPost(postsDir, (raw) => /^description: (?!>|\|)\S/m.test(raw), '单行描述的文章');
  const doc = Core.parsePost(sample.raw);
  Core.set(doc, 'description', '第一段\n第二段');
  const out = Core.stringifyPost(doc);
  const lines = lineFor(out, 'description');
  check(lines[0] === 'description: >-', '多行描述用折叠块', lines[0]);
  const back = Core.parsePost(out);
  check(Core.get(back, 'description') === '第一段 第二段', '折叠块回读为空格连接', Core.get(back, 'description'));

  Core.set(back, 'description', '单行描述，含中文逗号。');
  const out2 = Core.stringifyPost(back);
  check(out2.includes('description: 单行描述，含中文逗号。'), '改回单行');
   check(Core.get(Core.parsePost(out2), 'description') === '单行描述，含中文逗号。', '单行回读');
}

/* ---------- 4. cover：清空 / 设置 ---------- */
{
  const sample = pickPost(postsDir, (raw) => /^cover: \S/m.test(raw), '有封面的文章');
  const raw = sample.raw;
  const doc = Core.parsePost(raw);
  Core.set(doc, 'cover', '');
  check(lineFor(Core.stringifyPost(doc), 'cover')[0] === 'cover: ', '清空 cover 输出 "cover: "');
  check(doc.fields.cover.raw !== null, '原 cover 行被保留记录');

  const doc2 = Core.parsePost(raw);
  Core.set(doc2, 'cover', '/images/2026/01/new.jpg');
  check(lineFor(Core.stringifyPost(doc2), 'cover')[0] === 'cover: /images/2026/01/new.jpg', '设置 cover');
}

/* ---------- 5. abbrlink 放行 ---------- */
{
  const sample = pickPost(postsDir, (raw) => /^abbrlink: \S/m.test(raw), '有 abbrlink 的文章');
  const raw = sample.raw;
  const doc = Core.parsePost(raw);
  const abbr = (/^abbrlink: (\S+)/m.exec(raw) || [])[1];
  check(Core.get(doc, 'abbrlink') === abbr, '读到 abbrlink', Core.get(doc, 'abbrlink'));
  Core.set(doc, 'abbrlink', 'deadbeef');
  check(lineFor(Core.stringifyPost(doc), 'abbrlink')[0] === 'abbrlink: deadbeef', '写入 abbrlink');
}

/* ---------- 6. 新建文章：字段顺序 ---------- */
{
  const doc = Core.createPost();
  Core.set(doc, 'title', '测试标题');
  Core.set(doc, 'description', '测试描述');
  Core.set(doc, 'tags', ['测试', '网站']);
  const out = Core.stringifyPost(doc);
  const keys = fmLines(out).map((l) => l.split(':')[0]);
  check(JSON.stringify(keys) === JSON.stringify(['title', 'abbrlink', 'description', 'tags', 'date', 'cover']),
    '新文章字段顺序为规范顺序', keys.join(','));
  check(fmLines(out)[0] === 'title: 测试标题', '新文章 title 首行');
  check(/^date: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(fmLines(out)[4]), '新文章 date 格式', fmLines(out)[4]);
  check(fmLines(out)[5] === 'cover: ', '新文章空 cover 输出 "cover: "', fmLines(out)[5]);
  // 生成的文件必须能被 Hexo 的 js-yaml 解析
  const yaml = require('js-yaml');
  const parsed = yaml.load(fmLines(out).join('\n'));
  check(parsed.title === '测试标题', 'js-yaml 解析 title');
  check(JSON.stringify(parsed.tags) === JSON.stringify(['测试', '网站']), 'js-yaml 解析 tags');
}

/* ---------- 7. 特殊字符必须被 YAML 安全引用 ---------- */
{
  const tricky = [
    '冒号: 加空格',
    '开头是方括号 [x]',
    '井号 # 在中间',
    "'单引号开头",
    '"双引号开头',
    '- 短横线开头',
    '结尾有冒号:',
    '100% 确定',
    '@at 开头',
    'a & b'
  ];
  const yaml = require('js-yaml');
  const doc = Core.createPost();
  for (const t of tricky) {
    Core.set(doc, 'title', t);
    Core.set(doc, 'description', t);
    const out = Core.stringifyPost(doc);
    const fm = fmLines(out).join('\n');
    let parsed;
    try {
      parsed = yaml.load(fm);
    } catch (e) {
      check(false, `YAML 解析失败: ${t}`, e.message.split('\n')[0]);
      continue;
    }
    check(parsed.title === t, `title 往返: ${t}`, JSON.stringify(parsed.title));
    check(parsed.description === t, `description 往返: ${t}`, JSON.stringify(parsed.description));
  }
}

/* ---------- 8. abbrlink 算法 ---------- */
{
  // 与 node_modules/hexo-abbrlink/lib/crc32.js 的 crc32.str 对齐
  const crc32lib = require('hexo-abbrlink/lib/crc32.js');
  const samples = ['测试', 'こんにちは', 'Star night snow', '🎉 emoji', ''];
  for (const s of samples) {
    const a = (crc32lib.str(s) >>> 0).toString(16);
    const b = Core.crc32(s).toString(16);
    check(a === b, `crc32 与 hexo-abbrlink 一致: "${s}"`, `${a} vs ${b}`);
  }
}

/* ---------- 9. 文件名 ---------- */
{
  check(Core.suggestFilename('示例标题', '2026-10-25 12:00:00', 'yy') === '26 示例标题.md', 'yy 前缀');
  check(Core.suggestFilename('测试', '2026-10-25 12:00:00', 'yymm') === '2610 测试.md', 'yymm 前缀');
  check(Core.suggestFilename('a/b:c*d?', '2026-10-25 12:00:00', 'none') === 'abcd.md', '非法字符过滤', Core.suggestFilename('a/b:c*d?', '2026-10-25 12:00:00', 'none'));
  check(Core.suggestFilename('  ', '2026-10-25 12:00:00', 'none') === 'untitled.md', '空标题兜底');
}

/* ---------- 10. 视频块 ---------- */
{
  const block = Core.buildVideoBlock({
    bvid: 'BV1CibC6BEdT',
    youtube: 'https://youtu.be/bI5YOkr5-Lc',
    style: 'padded'
  });
  const containerId = block.match(/<div id="([^"]+)"/)[1];
  check(block === `<div id="${containerId}">
  <p>请稍等，正在根据您的网络加载播放器……</p>
</div>
<script>
(function(container) {
  function loadBilibiliVideo() {
      const videoHtml = \`<div style="position: relative; padding: 30% 45%;"><iframe style="position: absolute; width: 100%; height: 100%; left: 0; top: 0;" src="https://player.bilibili.com/player.html?bvid=BV1CibC6BEdT&page=1&high_quality=1&danmaku=0" frameborder="no" scrolling="no"></iframe></div><br>\`;
      return videoHtml;}
  function loadYouTubeVideo() {
      const videoHtml = \`<div style="position: relative; padding: 30% 45%;"><iframe style="position: absolute; width: 100%; height: 100%; left: 0; top: 0;" src="https://www.youtube.com/embed/bI5YOkr5-Lc" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div><br>\`;
      return videoHtml;}
  checkGoogle().then(function(status) {
  if (status === 0) {
        container.innerHTML = loadBilibiliVideo();
  } else {
        container.innerHTML = loadYouTubeVideo();
    }
  });
})(document.currentScript ? document.currentScript.previousElementSibling : document.getElementById("${containerId}"));
</script>`, '视频块隔离容器与播放器模板', block.split('\n').slice(0, 6).join('\n'));

  // 语料中 aid+cid 的写法必须能复现
  const old = Core.buildVideoBlock({ aid: '32664783113', cid: '32664783113', youtube: 'wqqqpAodDvg', style: 'simple' });
  check(old.includes('https://player.bilibili.com/player.html?cid=32664783113&aid=32664783113&page=1&as_wide=1&high_quality=1&danmaku=0'),
    'aid+cid 旧式地址');
  check(old.includes('<iframe width="100%" height="450" src="https://www.youtube.com/embed/wqqqpAodDvg"'),
    'simple 样式 YouTube iframe');

  // auto=false：二选一，只输出单一平台 iframe，不检测网络
  const singleBili = Core.buildVideoBlock({ bvid: 'BV1CibC6BEdT', auto: false, style: 'padded' });
  check(!singleBili.includes('<script>') && !singleBili.includes('checkGoogle'), '二选一：哔哩哔哩不带 script/checkGoogle');
  check(singleBili.includes('player.bilibili.com/player.html?bvid=BV1CibC6BEdT'), '二选一：直接输出 B 站 iframe');
  check(singleBili.includes('<iframe'), '二选一：含 iframe');

  const singleYt = Core.buildVideoBlock({ youtube: 'bI5YOkr5-Lc', auto: false, style: 'simple' });
  check(!singleYt.includes('<script>') && !singleYt.includes('checkGoogle'), '二选一：YouTube 不带 script/checkGoogle');
  check(singleYt.includes('<iframe width="100%" height="450" src="https://www.youtube.com/embed/bI5YOkr5-Lc"'),
    '二选一：直接输出 YouTube iframe');

  // auto 默认 true：仍与语料一致（判断网络）
  const autoDefault = Core.buildVideoBlock({ bvid: 'BV1CibC6BEdT', youtube: 'bI5YOkr5-Lc' });
  check(autoDefault.includes('checkGoogle()'), '默认 auto=true 仍含 checkGoogle');
  check(/<div id="videoContainer-[^"]+">/.test(autoDefault), '默认 auto=true 含视频容器');

  check(Core.normalizeYoutubeId('https://www.youtube.com/watch?v=GblT7c9B-24&t=1') === 'GblT7c9B-24', 'YT 从 watch 链接取 id');
  check(Core.normalizeYoutubeId('https://youtu.be/GblT7c9B-24?si=abc') === 'GblT7c9B-24', 'YT 从短链取 id');
  check(Core.normalizeBilibiliId('https://www.bilibili.com/video/BV1gQiuBKE1x/').bvid === 'BV1gQiuBKE1x', 'B 站从链接取 BV');
}

/* ---------- 11. 校验 ---------- */
{
  const doc = Core.createPost();
  const issues = Core.validate(doc).map((i) => i.field);
  check(issues.includes('title'), '空标题报错');
  check(issues.includes('tags'), '空标签告警');
  const ok = Core.createPost();
  Core.set(ok, 'title', 'x');
  Core.set(ok, 'tags', ['a']);
  Core.set(ok, 'description', 'd');
  Core.set(ok, 'cover', '/images/a.jpg');
  Core.set(ok, 'abbrlink', 'abcd1234');
  check(Core.validate(ok).filter((i) => i.level === 'error').length === 0, '完整文章无 error');
}

console.log(`断言 ${checks} 条，失败 ${failed} 条`);
process.exit(failed === 0 ? 0 : 1);

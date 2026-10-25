/*!
 * Hexo Post Core v1.0
 * 纯函数：Front Matter 解析 / 序列化、abbrlink(crc32)、文件名、视频块模板。
 * 无任何依赖，浏览器与 Node 通用（浏览器挂到 window.HexoCore）。
 *
 * 设计目标：**未修改的字段按原样回写**（逐字节保留），
 * 因此对 D:\ZEROKAMI\source\_posts 下 89 篇文章做「读入 → 直接序列化」
 * 必须是 byte-identical，测试见 test/roundtrip.test.mjs。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HexoCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 新建文章时的字段顺序（来自语料里 51/89 篇的主流顺序） */
  var CANONICAL_ORDER = ['title', 'abbrlink', 'description', 'tags', 'date', 'cover'];
  var KNOWN_FIELDS = ['title', 'abbrlink', 'description', 'tags', 'date', 'cover'];
  var KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$/;

  /* ------------------------------------------------------------------ *
   * 1. 基础工具
   * ------------------------------------------------------------------ */

  function isKnown(key) {
    return KNOWN_FIELDS.indexOf(key) !== -1;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** Date -> 'YYYY-MM-DD HH:mm:ss'（本地时间，不经过 toISOString，避免时区偏移） */
  function formatDateTime(d) {
    return (
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    );
  }

  /** Date -> 'YYYY-MM-DD' */
  function formatDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 解析 'YYYY-MM-DD[ HH:mm[:ss]]'，非法返回 null */
  function parseDate(value) {
    if (!value) return null;
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(String(value).trim());
    if (!m) return null;
    var d = new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      m[4] ? Number(m[4]) : 0,
      m[5] ? Number(m[5]) : 0,
      m[6] ? Number(m[6]) : 0
    );
    if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
      return null;
    }
    return d;
  }

  function hasTimePart(value) {
    return /^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}/.test(String(value || '').trim());
  }

  /* ------------------------------------------------------------------ *
   * 2. YAML 标量（只覆盖本站文章的写法，不做通用 YAML）
   * ------------------------------------------------------------------ */

  /** 去掉一层单/双引号 */
  function unquote(s) {
    s = String(s == null ? '' : s).trim();
    if (s.length >= 2) {
      var q = s.charAt(0);
      if (q === "'" && s.charAt(s.length - 1) === "'") {
        return s.slice(1, -1).replace(/''/g, "'");
      }
      if (q === '"' && s.charAt(s.length - 1) === '"') {
        try {
          return JSON.parse(s);
        } catch (e) {
          return s.slice(1, -1);
        }
      }
    }
    return s;
  }

  /** 该字符串作为 YAML plain scalar 是否安全 */
  function isPlainSafe(s) {
    if (s === '') return false;
    if (/^\s|\s$/.test(s)) return false;
    if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false;
    if (/: |:$| #/.test(s)) return false;
    if (/[\n\r\t]/.test(s)) return false;
    return true;
  }

  /** 输出单行标量：安全则原样，否则单引号 */
  function formatScalar(s) {
    s = s == null ? '' : String(s);
    if (s === '') return '';
    if (isPlainSafe(s)) return s;
    return "'" + s.replace(/'/g, "''") + "'";
  }

  /**
   * description 专用：单行 → 标量；多行 → `>-` 折叠块（与语料中 5 篇一致）
   */
  function formatDescription(s) {
    s = s == null ? '' : String(s).replace(/\r\n/g, '\n').trim();
    if (s === '') return '';
    if (s.indexOf('\n') === -1) return formatScalar(s);
    var lines = s.split('\n');
    var out = ['>-'];
    for (var i = 0; i < lines.length; i++) {
      out.push('  ' + lines[i].replace(/\s+$/, ''));
    }
    return out.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 3. Front Matter 拆分
   * ------------------------------------------------------------------ */

  /**
   * 拆出 front matter 与正文。
   * 兼容 BOM / CRLF / 结尾无换行；只认「行首的 ---」。
   * @returns {{hasFront:boolean, front:Array<string>|null, body:string, eol:string}}
   */
  function splitFront(raw) {
    var text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
    var eol = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
    var lines = text.split(/\r?\n/);
    if (lines.length < 3 || lines[0].replace(/\s+$/, '') !== '---') {
      return { hasFront: false, front: null, body: text, eol: eol };
    }
    for (var i = 1; i < lines.length; i++) {
      if (lines[i].replace(/\s+$/, '') === '---') {
        return {
          hasFront: true,
          front: lines.slice(1, i),
          body: lines.slice(i + 1).join(eol),
          eol: eol
        };
      }
    }
    return { hasFront: false, front: null, body: text, eol: eol };
  }

  /** 把 front matter 行按「key: ...」切成块（缩进行自动归属上一块） */
  function splitBlocks(lines) {
    var blocks = [];
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m = !/^\s/.test(line) && KEY_RE.exec(line);
      if (m) {
        cur = { key: m[1], lines: [line] };
        blocks.push(cur);
      } else if (cur) {
        cur.lines.push(line);
      }
      // cur 为 null 时是无主行（理论上不会出现），直接丢弃，保持输出稳定
    }
    return blocks;
  }

  /** 单块 → 字段值 */
  function readBlock(block) {
    var first = block.lines[0];
    var m = KEY_RE.exec(first);
    var inline = m ? m[2].replace(/^\s+/, '') : '';
    var rest = block.lines.slice(1);

    if (block.key === 'tags' || block.key === 'categories') {
      if (/^\[.*\]\s*$/.test(inline.trim())) {
        var inner = inline.trim().slice(1, -1).trim();
        if (!inner) return [];
        return inner.split(',').map(function (t) {
          return unquote(t);
        }).filter(function (t) {
          return t !== '';
        });
      }
      // 块列表
      var arr = [];
      rest.forEach(function (l) {
        var mm = /^\s*-\s+(.*)$/.exec(l);
        if (mm) arr.push(unquote(mm[1]));
      });
      if (arr.length) return arr;
      return inline.trim() ? [unquote(inline)] : [];
    }

    if (block.key === 'description') {
      var head = inline.trim();
      if (/^[>|][+-]?$/.test(head)) {
        var joined = rest.map(function (l) {
          return l.replace(/^\s+/, '');
        }).join(' ');
        return joined.replace(/\s+/g, ' ').trim();
      }
      return unquote(inline);
    }

    // title / abbrlink / cover / date / author / updated ...
    return unquote(inline);
  }

  /* ------------------------------------------------------------------ *
   * 4. 文档对象
   * ------------------------------------------------------------------ */

  /**
   * @typedef {{value:*, touched:boolean, raw:string[]|null}} Field
   * @typedef {{
   *   keyOrder:string[], fields:Object<string,Field>, unknown:Object<string,string[]>,
   *   body:string, eol:string, hasFront:boolean, raw:string, isNew:boolean
   * }} Doc
   */

  /**
   * 解析一篇 .md
   * @param {string} raw
   * @param {{isNew?:boolean}} [opts]
   * @returns {Doc}
   */
  function parsePost(raw, opts) {
    opts = opts || {};
    var split = splitFront(raw);
    var doc = {
      keyOrder: [],
      fields: {},
      unknown: {},
      body: split.hasFront ? split.body : String(raw == null ? '' : raw),
      eol: split.eol,
      hasFront: split.hasFront,
      raw: raw,
      isNew: !!opts.isNew
    };

    var blocks = split.hasFront ? splitBlocks(split.front) : [];
    doc.present = {};
    blocks.forEach(function (block) {
      if (doc.keyOrder.indexOf(block.key) === -1) doc.keyOrder.push(block.key);
      if (isKnown(block.key)) {
        doc.present[block.key] = true;
        if (!doc.fields[block.key]) {
          doc.fields[block.key] = { value: readBlock(block), touched: false, raw: block.lines.slice() };
        }
      } else {
        doc.unknown[block.key] = block.lines.slice();
      }
    });

    // 兜底：补齐缺失的已知字段（新建文章 / 手写残缺文件）
    ensureFields(doc);
    if (doc.fields.date) {
      doc.fields.date.hasTime = hasTimePart(doc.fields.date.value);
    }
    return doc;
  }

  function ensureFields(doc) {
    KNOWN_FIELDS.forEach(function (key) {
      if (!doc.fields[key]) {
        var value = key === 'tags' ? [] : '';
        if (key === 'date') value = '';
        // touched:false + 没在 present 里 → 解析态下不会凭空写进 front matter
        doc.fields[key] = { value: value, touched: false, raw: null };
        if (key === 'date') doc.fields[key].hasTime = true;
      }
    });
  }

  /** 读字段值 */
  function get(doc, key) {
    var f = doc.fields[key];
    return f ? f.value : '';
  }

  /** 写字段值（标记 touched，序列化时按规范格式重写） */
  function set(doc, key, value) {
    var f = doc.fields[key];
    if (!f) {
      f = doc.fields[key] = { value: value, touched: true, raw: null };
    }
    var same = JSON.stringify(f.value) === JSON.stringify(value);
    if (!f.touched && same) return doc;
    if (f.raw && same) {
      // 值没变，保持原样回写
      f.touched = false;
      return doc;
    }
    f.value = value;
    f.touched = true;
    return doc;
  }

  /**
   * 该字段是否要写进 front matter。
   * 原文件里就有的字段一律保留（哪怕是空的 cover），
   * 原文件里没有的只有「新建文章」才补齐。
   */
  function shouldEmit(doc, key) {
    if (doc.isNew) return Object.prototype.hasOwnProperty.call(doc.fields, key);
    return !!doc.present[key] || (doc.fields[key] && doc.fields[key].touched);
  }

  /**
   * 输出字段行（数组）
   * 未 touched 且原本就存在 → 原样返回原始行，保证零 diff。
   */
  function emitField(doc, key) {
    var f = doc.fields[key];
    if (!f) return [];
    if (!f.touched && f.raw) return f.raw.slice();

    var v = f.value;
    if (key === 'tags') {
      return ['tags: [' + (Array.isArray(v) ? v.map(formatScalar).join(', ') : '') + ']'];
    }
    if (key === 'description') {
      var text = formatDescription(v);
      if (text.indexOf('\n') === -1) return ['description: ' + text];
      var parts = text.split('\n');
      parts[0] = 'description: ' + parts[0];
      return parts;
    }
    if (key === 'date') {
      return ['date: ' + (v ? String(v) : formatDateTime(new Date()))];
    }
    return [key + ': ' + formatScalar(v)];
  }

  /** 计算最终输出顺序：保留原顺序，补入缺失的规范字段 */
  function orderedKeys(doc) {
    var keys = doc.keyOrder.filter(function (k) {
      return isKnown(k) ? shouldEmit(doc, k) : Object.prototype.hasOwnProperty.call(doc.unknown, k);
    });
    if (doc.isNew) {
      CANONICAL_ORDER.forEach(function (k) {
        if (shouldEmit(doc, k) && keys.indexOf(k) === -1) keys.push(k);
      });
      return keys;
    }
    CANONICAL_ORDER.forEach(function (k) {
      if (!shouldEmit(doc, k) || keys.indexOf(k) !== -1) return;
      var idx = -1;
      for (var i = 0; i < CANONICAL_ORDER.indexOf(k); i++) {
        var p = keys.indexOf(CANONICAL_ORDER[i]);
        if (p > idx) idx = p;
      }
      keys.splice(idx + 1, 0, k);
    });
    return keys;
  }

  /**
   * 序列化为 md 文本
   * @param {Doc} doc
   * @returns {string}
   */
  function stringifyPost(doc) {
    var eol = doc.eol || '\n';
    var out = [];
    orderedKeys(doc).forEach(function (key) {
      var lines = isKnown(key) ? emitField(doc, key) : doc.unknown[key];
      (lines || []).forEach(function (l) {
        out.push(l);
      });
    });
    var head = ['---'].concat(out).concat(['---']).join(eol);
    if (doc.body === '' || doc.body == null) return head + eol;
    return head + eol + doc.body;
  }

  /** 新建空文档 */
  function createPost(fields) {
    var now = new Date();
    var doc = {
      keyOrder: CANONICAL_ORDER.slice(),
      fields: {},
      present: {},
      unknown: {},
      body: '',
      eol: '\n',
      hasFront: true,
      raw: '',
      isNew: true
    };
    KNOWN_FIELDS.forEach(function (key) {
      var v = key === 'tags' ? [] : '';
      if (key === 'date') v = formatDateTime(now);
      doc.fields[key] = { value: v, touched: true, raw: null };
      doc.present[key] = true;
      if (key === 'date') doc.fields[key].hasTime = true;
    });
    if (fields) {
      Object.keys(fields).forEach(function (k) {
        set(doc, k, fields[k]);
      });
    }
    return doc;
  }

  /* ------------------------------------------------------------------ *
   * 5. abbrlink（与 hexo-abbrlink 的 crc32(UTF-8) 实现一致）
   * ------------------------------------------------------------------ */

  var CRC_TABLE = (function () {
    var table = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = c & 1 ? -306674912 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
    return table;
  })();

  /** SheetJS crc32.str 的等价实现（按 UTF-8 展开码点） */
  function crc32(str) {
    var C = -1;
    var T = CRC_TABLE;
    for (var i = 0, L = str.length, c, d; i < L; ) {
      c = str.charCodeAt(i++);
      if (c < 0x80) {
        C = (C >>> 8) ^ T[(C ^ c) & 0xff];
      } else if (c < 0x800) {
        C = (C >>> 8) ^ T[(C ^ (192 | ((c >> 6) & 31))) & 0xff];
        C = (C >>> 8) ^ T[(C ^ (128 | (c & 63))) & 0xff];
      } else if (c >= 0xd800 && c < 0xe000) {
        c = (c & 1023) + 64;
        d = str.charCodeAt(i++) & 1023;
        C = (C >>> 8) ^ T[(C ^ (240 | ((c >> 8) & 7))) & 0xff];
        C = (C >>> 8) ^ T[(C ^ (128 | ((c >> 2) & 63))) & 0xff];
        C = (C >>> 8) ^ T[(C ^ (128 | ((d >> 6) & 15) | ((c & 3) << 4))) & 0xff];
        C = (C >>> 8) ^ T[(C ^ (128 | (d & 63))) & 0xff];
      } else {
        C = (C >>> 8) ^ T[(C ^ (224 | ((c >> 12) & 15))) & 0xff];
        C = (C >>> 8) ^ T[(C ^ (128 | ((c >> 6) & 63))) & 0xff];
        C = (C >>> 8) ^ T[(C ^ (128 | (c & 63))) & 0xff];
      }
    }
    return (C ^ -1) >>> 0;
  }

  /**
   * 按 _config.yml 的 abbrlink 配置预估（alg: crc32 / rep: hex）
   * 注意：Hexo 只在 abbrlink 缺失时写入，标题改动后不会重算，
   * 所以这里只是「预估」，可能与 generate 的结果不同。
   */
  function predictAbbrlink(title) {
    if (!title) return '';
    return (crc32(String(title)) >>> 0).toString(16);
  }

  /* ------------------------------------------------------------------ *
   * 6. 文件名
   * ------------------------------------------------------------------ */

  var ILLEGAL_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;

  /** 文件名安全化（保留中文与空格，与现有命名一致） */
  function sanitizeFilename(name) {
    return String(name == null ? '' : name)
      .replace(ILLEGAL_FILENAME, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\.+$/, '')
      .trim();
  }

  /**
   * 建议文件名：<前缀> <标题>.md
   * 语料前缀规则：2024 及以前用两位年份（20/21/22/23/24/25/26），
   * 2026 下半年起出现四位 YYMM（2607/2608/2609）。
   * @param {string} title
   * @param {Date|string} date
   * @param {'yy'|'yymm'|'none'} mode
   */
  function suggestFilename(title, date, mode) {
    var d = date instanceof Date ? date : parseDate(date) || new Date();
    var prefix = '';
    if (mode === 'yymm') prefix = String(d.getFullYear()).slice(2) + pad2(d.getMonth() + 1);
    else if (mode !== 'none') prefix = String(d.getFullYear()).slice(2);
    var base = sanitizeFilename(title) || 'untitled';
    return (prefix ? prefix + ' ' : '') + base + '.md';
  }

  /* ------------------------------------------------------------------ *
   * 7. 视频块（严格复刻文章里的模板）
   * ------------------------------------------------------------------ */

  var YT_ALLOW = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';

  function normalizeYoutubeId(input) {
    var s = String(input || '').trim();
    if (!s) return '';
    var m = /(?:youtu\.be\/|v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{6,})/.exec(s);
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{6,}$/.test(s)) return s;
    return '';
  }

  function normalizeBilibiliId(input) {
    var s = String(input || '').trim();
    var out = { bvid: '', aid: '' };
    if (!s) return out;
    var bv = /(BV[0-9A-Za-z]{8,})/.exec(s);
    if (bv) out.bvid = bv[1];
    var av = /(?:^|[^a-z])(av(\d+))/i.exec(s);
    if (av) out.aid = av[2];
    return out;
  }

  /** 哔哩哔哩播放器地址：有 aid+cid 用旧式，否则用 bvid 式 */
  function bilibiliSrc(opt) {
    if (opt.aid && opt.cid) {
      return 'https://player.bilibili.com/player.html?cid=' + opt.cid + '&aid=' + opt.aid +
        '&page=' + (opt.page || 1) + '&as_wide=1&high_quality=1&danmaku=0';
    }
    if (opt.aid && opt.bvid) {
      return 'https://player.bilibili.com/player.html?isOutside=true&aid=' + opt.aid +
        '&bvid=' + opt.bvid + '&cid=' + (opt.cid || '') + '&p=' + (opt.page || 1);
    }
    return 'https://player.bilibili.com/player.html?bvid=' + (opt.bvid || '') +
      '&page=' + (opt.page || 1) + '&high_quality=1&danmaku=0';
  }

  function bilibiliIframe(src, style) {
    if (style === 'simple') {
      return '<iframe width="100%" height="450" src="' + src +
        '" frameborder="no" scrolling="no" allowfullscreen></iframe>';
    }
    return '<div style="position: relative; padding: 30% 45%;"><iframe style="position: absolute; ' +
      'width: 100%; height: 100%; left: 0; top: 0;" src="' + src +
      '" frameborder="no" scrolling="no"></iframe></div><br>';
  }

  function youtubeIframe(id, style) {
    var src = 'https://www.youtube.com/embed/' + id;
    if (style === 'simple') {
      return '<iframe width="100%" height="450" src="' + src + '" title="YouTube video player" ' +
        'frameborder="0" allow="' + YT_ALLOW + '" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>';
    }
    return '<div style="position: relative; padding: 30% 45%;"><iframe style="position: absolute; ' +
      'width: 100%; height: 100%; left: 0; top: 0;" src="' + src + '" title="YouTube video player" ' +
      'frameborder="0" allow="' + YT_ALLOW + '" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div><br>';
  }

  /**
   * 生成整块视频代码（与 23 篇文章里的写法一致）
   * @param {{bvid?:string, aid?:string, cid?:string, page?:number|string,
   *          youtube?:string, style?:'padded'|'simple', includeQuote?:boolean,
   *          auto?:boolean, bilibiliUrl?:string, youtubeUrl?:string}} opt
   *   auto = true（默认）：用 checkGoogle() 判断网络，自动在哔哩哔哩 / YouTube 间选择；
   *   auto = false：不判断网络，只输出单一平台的播放器 iframe。
   */
  function buildVideoBlock(opt) {
    opt = opt || {};
    var style = opt.style === 'simple' ? 'simple' : 'padded';
    var bv = normalizeBilibiliId(opt.bvid || '');
    var video = {
      bvid: bv.bvid,
      aid: String(opt.aid || bv.aid || '').trim(),
      cid: String(opt.cid || '').trim(),
      page: String(opt.page || 1).trim() || 1
    };
    var yt = normalizeYoutubeId(opt.youtube || '');
    var auto = opt.auto !== false;
    var lines = [];

    if (!auto) {
      // 二选一：直接输出单一平台播放器，不检测网络
      if (video.bvid || video.aid) {
        lines.push(bilibiliIframe(bilibiliSrc(video), style));
      } else if (yt) {
        lines.push(youtubeIframe(yt, style));
      }
    } else {
      lines.push('<div id="videoContainer">');
      lines.push('  <p>请稍等，正在根据您的网络加载播放器……</p>');
      lines.push('</div>');
      lines.push('<script>');

      if (video.bvid || video.aid) {
        lines.push('  function loadBilibiliVideo() {');
        lines.push('      const videoHtml = `' + bilibiliIframe(bilibiliSrc(video), style) + '`;');
        lines.push('      return videoHtml;}');
      }
      if (yt) {
        lines.push('  function loadYouTubeVideo() {');
        lines.push('      const videoHtml = `' + youtubeIframe(yt, style) + '`;');
        lines.push('      return videoHtml;}');
      }
      lines.push('  checkGoogle().then(function(status) {');
      if (video.bvid || video.aid) {
        lines.push('  if (status === 0) {');
        lines.push('        document.getElementById("videoContainer").innerHTML = loadBilibiliVideo();');
        lines.push('  } else {');
        lines.push('        document.getElementById("videoContainer").innerHTML = loadYouTubeVideo();');
        lines.push('    }');
      } else {
        lines.push('        document.getElementById("videoContainer").innerHTML = loadYouTubeVideo();');
      }
      lines.push('  });');
      lines.push('</script>');
    }

    if (opt.includeQuote) {
      var q = ['', '> 视频'];
      if (opt.bilibiliUrl) q.push('> 哔哩哔哩 ' + String(opt.bilibiliUrl).trim());
      if (opt.youtubeUrl) q.push('> YouTuBe ' + String(opt.youtubeUrl).trim());
      if (q.length > 2) lines = lines.concat(q);
    }
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 8. 校验
   * ------------------------------------------------------------------ */

  /**
   * @returns {Array<{field:string, level:'error'|'warn', message:string}>}
   */
  function validate(doc) {
    var issues = [];
    var title = String(get(doc, 'title') || '').trim();
    if (!title) issues.push({ field: 'title', level: 'error', message: '标题不能为空' });

    var date = String(get(doc, 'date') || '').trim();
    if (!date) issues.push({ field: 'date', level: 'error', message: '日期不能为空' });
    else if (!parseDate(date)) issues.push({ field: 'date', level: 'error', message: '日期格式应为 YYYY-MM-DD HH:mm:ss' });

    var tags = get(doc, 'tags');
    if (!Array.isArray(tags) || tags.length === 0) {
      issues.push({ field: 'tags', level: 'warn', message: '没有标签，归档与标签页里不会出现该文章' });
    }
    tags = Array.isArray(tags) ? tags : [];
    tags.forEach(function (t) {
      if (/[,]/.test(t)) issues.push({ field: 'tags', level: 'warn', message: '标签「' + t + '」含逗号，Hexo 会拆成两个标签' });
    });

    var cover = String(get(doc, 'cover') || '').trim();
    if (cover && !/^(\/|https?:\/\/)/.test(cover)) {
      issues.push({ field: 'cover', level: 'warn', message: '封面建议用站内绝对路径 /images/... 或完整 http(s) 地址' });
    }
    var desc = String(get(doc, 'description') || '').trim();
    if (!desc) issues.push({ field: 'description', level: 'warn', message: '没有描述，社交卡片与搜索结果会缺少摘要' });

    var abbr = String(get(doc, 'abbrlink') || '').trim();
    if (!abbr) issues.push({ field: 'abbrlink', level: 'warn', message: 'abbrlink 为空：执行 hexo generate 后会自动填入' });

    return issues;
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  return {
    CANONICAL_ORDER: CANONICAL_ORDER,
    KNOWN_FIELDS: KNOWN_FIELDS,
    parsePost: parsePost,
    stringifyPost: stringifyPost,
    createPost: createPost,
    get: get,
    set: set,
    validate: validate,
    formatDateTime: formatDateTime,
    formatDate: formatDate,
    parseDate: parseDate,
    hasTimePart: hasTimePart,
    isPlainSafe: isPlainSafe,
    formatScalar: formatScalar,
    formatDescription: formatDescription,
    crc32: crc32,
    predictAbbrlink: predictAbbrlink,
    sanitizeFilename: sanitizeFilename,
    suggestFilename: suggestFilename,
    buildVideoBlock: buildVideoBlock,
    normalizeYoutubeId: normalizeYoutubeId,
    normalizeBilibiliId: normalizeBilibiliId,
    splitFront: splitFront
  };
});

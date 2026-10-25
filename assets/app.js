/*!
 * Hexo 文章编辑器 · 主程序
 * 依赖：core.js（格式层）
 * 无后端、无构建、无依赖：浏览器直接打开 index.html 即可（双击就行）
 */
(function () {
  'use strict';

  var Core = window.HexoCore;

  /* ================================================================
   * 0. 小工具
   * ================================================================ */
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, kind === 'err' ? 4200 : 2400);
  }

  function debounce(fn, wait) {
    var h = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(h);
      h = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  /** 简单确认 / 表单弹窗 */
  function openModal(opts) {
    return new Promise(function (resolve) {
      var modal = $('#modal');
      $('#modal-title').textContent = opts.title || '';
      var body = $('#modal-body');
      body.innerHTML = '';
      if (typeof opts.body === 'string') body.innerHTML = opts.body;
      else if (opts.body) body.appendChild(opts.body);

      var foot = $('#modal-foot');
      foot.innerHTML = '';
      var closed = false;
      function close(val) {
        if (closed) return;
        closed = true;
        modal.classList.add('hidden');
        document.removeEventListener('keydown', onKey);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && opts.enterConfirm !== false) {
          var primary = foot.querySelector('.btn.primary');
          if (primary) { e.preventDefault(); primary.click(); }
        }
      }
      (opts.actions || [{ label: '关闭', primary: true, value: true }]).forEach(function (a) {
        foot.appendChild(el('button', {
          class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''),
          text: a.label,
          onclick: function () {
            if (a.onClick) {
              var r = a.onClick(body, close);
              if (r === false) return;
            }
            close(a.value === undefined ? true : a.value);
          }
        }));
      });
      $('#modal-close').onclick = function () { close(null); };
      modal.classList.remove('hidden');
      document.addEventListener('keydown', onKey);
      setTimeout(function () {
        var first = body.querySelector('input, textarea, select');
        if (first) first.focus();
      }, 30);
    });
  }

  function promptText(title, label, value, placeholder) {
    var wrap = el('label', { class: 'field' }, [
      el('span', { class: 'lbl', text: label }),
      el('input', { type: 'text', value: value || '', placeholder: placeholder || '' })
    ]);
    var input = wrap.querySelector('input');
    return openModal({
      title: title,
      body: wrap,
      actions: [
        { label: '取消', value: null },
        { label: '确定', primary: true, onClick: function () { return input.value.trim() !== '' || true; }, value: 'ok' }
      ]
    }).then(function (r) { return r === 'ok' ? input.value.trim() : null; });
  }

  function downloadBlob(text, filename) {
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  /* ================================================================
   * 1. IndexedDB（记住上次打开的目录）
   * ================================================================ */
  var idb = (function () {
    var DB = 'hexo-editor', STORE = 'handles';
    function open() {
      return new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }
    return {
      get: function (key) {
        return open().then(function (db) {
          return new Promise(function (resolve) {
            var tx = db.transaction(STORE, 'readonly');
            var r = tx.objectStore(STORE).get(key);
            r.onsuccess = function () { resolve(r.result || null); };
            r.onerror = function () { resolve(null); };
          });
        }).catch(function () { return null; });
      },
      set: function (key, val) {
        return open().then(function (db) {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(val, key);
        }).catch(function () {});
      },
      del: function (key) {
        return open().then(function (db) {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(key);
        }).catch(function () {});
      }
    };
  })();

  /* ================================================================
   * 2. 状态
   * ================================================================ */
  var state = {
    mode: 'demo',           // 'fs' | 'files' | 'demo'
    root: null,             // 项目根目录 handle
    postsDir: null,         // source/_posts handle
    imagesDir: null,        // source/images handle
    hasImages: false,
    rootRemembered: null,   // 记得住但还没授权的文章目录 handle
    imagesRemembered: null, // 记得住但还没授权的图片目录 handle
    sidebarCollapsed: false,// 打开文章后侧栏是否收起
    posts: [],              // { id, path, name, doc, raw, handle, dirty, savedOnce }
    current: null,
    filter: { q: '', tags: [], dirtyOnly: false, sort: 'date-desc' },
    imageCache: new Map()
  };

  var hasFSA = typeof window.showDirectoryPicker === 'function';

  function uid() { return Math.random().toString(36).slice(2, 10); }

  /**
   * 图片文件名：10 位随机「数字+小写字母」组合，后缀沿用原文件的
   * （站内 167 处图片都是这种无意义短名，避免中文/空格/重名问题）
   */
  var IMG_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  function randomImageName(ext) {
    var s = '';
    for (var i = 0; i < 10; i++) s += IMG_CHARS.charAt(Math.floor(Math.random() * IMG_CHARS.length));
    return s + (ext || '');
  }

  /** 取原文件的扩展名（含点），取不到就用 .jpg */
  function fileExt(name) {
    var m = /\.[A-Za-z0-9]+$/.exec(String(name || ''));
    return m ? m[0] : '.jpg';
  }

  /* ================================================================
   * 3. 文件系统层
   * ================================================================ */
  var FS = {
    /** 选目录：优先当项目根目录，其次当 _posts */
    async pick() {
      var handle;
      try {
        handle = await window.showDirectoryPicker({ id: 'hexo-root', mode: 'readwrite' });
      } catch (e) {
        if (e && e.name === 'AbortError') return false;
        throw e;
      }
      await idb.set('root', handle);
      return FS.attach(handle);
    },

    /** 判断目录里有没有某个子目录 */
    async subdir(handle, name) {
      try {
        return await handle.getDirectoryHandle(name);
      } catch (e) {
        return null;
      }
    },

    /** 绑定一个目录 handle：自动识别是项目根 / source / _posts */
    async attach(handle) {
      var perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') toast('没有写入权限，只能只读浏览', 'err');
      }

      var root = null, postsDir = null, imagesDir = null;
      var lower = handle.name.toLowerCase();

      // ① 项目根：<root>/source/_posts
      var src = lower === 'source' ? handle : await FS.subdir(handle, 'source');
      if (src) {
        var posts = await FS.subdir(src, '_posts');
        if (posts) {
          postsDir = posts;
          imagesDir = await FS.subdir(src, 'images');
          root = lower === 'source' ? null : handle;
        }
      }

      // ② 直接是 _posts
      if (!postsDir && (lower === '_posts' || await FS.hasMdFiles(handle))) {
        postsDir = handle;
      }

      // ③ 目录下就有 _posts
      if (!postsDir) {
        var sub = await FS.subdir(handle, '_posts');
        if (sub) postsDir = sub;
      }

      if (!postsDir) throw new Error('这个目录里没找到 source/_posts，也没有 .md 文件');

      state.mode = 'fs';
      state.root = root;
      state.postsDir = postsDir;
      // 用户如果之前单独连过图片目录，就不要被这次识别覆盖掉
      if (!state.imagesDir) {
        state.imagesDir = imagesDir;
      }
      state.hasImages = !!state.imagesDir;
      state.dirName = root ? root.name : postsDir.name;
      state.posts = [];
      state.current = null;
      await FS.loadAll();
      // 目录名 / 模式提示要立刻反映到界面上（哪怕 attach 是被恢复流程调用的）
      if (typeof updateModeUI === 'function') updateModeUI();
      return true;
    },

    /**
     * 单独连接 source/images。
     * 场景：直接打开 index.html 或只选了 _posts 时，浏览器拿不到父目录，
     * 也就找不到同级的 images —— 这时让用户手动指一次。
     */
    async pickImages() {
      var handle;
      try {
        handle = await window.showDirectoryPicker({ id: 'hexo-images', mode: 'readwrite' });
      } catch (e) {
        if (e && e.name === 'AbortError') return false;
        throw e;
      }
      var perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });

      // 允许选中 images 本身，或选中含 images 的 source / 项目根
      var dir = handle;
      if (handle.name.toLowerCase() !== 'images') {
        var a = await FS.subdir(handle, 'images');
        if (a) dir = a;
        else {
          var b = await FS.subdir(handle, 'source');
          if (b) {
            var c = await FS.subdir(b, 'images');
            if (c) dir = c;
          }
        }
      }
      if (dir.name.toLowerCase() !== 'images') {
        toast('请选择 source/images 目录（当前选的是「' + handle.name + '」）', 'err');
        return false;
      }

      state.imagesDir = dir;
      state.hasImages = true;
      state.imageCache.clear();
      await idb.set('images', dir);
      updateModeUI();
      updateCoverPreview();
      return true;
    },

    async hasMdFiles(dir) {
      var seen = 0;
      for await (var entry of dir.values()) {
        if (entry.kind === 'file' && /\.md$/i.test(entry.name)) return true;
        if (entry.kind === 'file' && /_config\.ya?ml$/i.test(entry.name)) return false;
        seen += 1;
        if (seen > 40) break;
      }
      return false;
    },

    async loadAll() {
      var list = [];
      async function walk(dir, prefix) {
        for await (var entry of dir.values()) {
          if (entry.kind === 'directory') {
            await walk(entry, prefix + entry.name + '/');
            continue;
          }
          if (!/\.md$/i.test(entry.name)) continue;
          if (/^_/.test(entry.name) && !prefix) continue;
          try {
            var file = await entry.getFile();
            var raw = await file.text();
            var doc = Core.parsePost(raw);
            list.push({
              id: uid(),
              path: prefix + entry.name,
              name: entry.name,
              handle: entry,
              doc: doc,
              raw: raw,
              dirty: false,
              savedOnce: true,
              mtime: file.lastModified
            });
          } catch (e) {
            console.warn('读取失败', entry.name, e);
          }
        }
      }
      await walk(state.postsDir, '');
      state.posts = list;
      FS.reindex();
    },

    /** 重新读取磁盘上的文章（刷新 abbrlink 用） */
    async reload() {
      if (state.mode === 'fs') {
        var keep = state.current ? state.current.path : null;
        await FS.loadAll();
        if (keep) {
          var again = state.posts.find(function (p) { return p.path === keep; });
          if (again) openPost(again);
          else closeEditor();
        }
        toast('已重新读取 ' + state.posts.length + ' 篇文章');
        return;
      }
      toast('当前是导入模式，请重新选择文件夹');
    },

    async write(handleOrDir, name, text) {
      var fh = handleOrDir;
      if (fh.kind !== 'file') fh = await handleOrDir.getFileHandle(name, { create: true });
      var w = await fh.createWritable();
      // 直接写字符串：createWritable().write() 接受字符串，比包 Blob 更省事也更兼容
      await w.write(text);
      await w.close();
      return fh;
    },

    async remove(name) {
      await state.postsDir.removeEntry(name);
    },

    async readImage(relPath) {
      if (!state.imagesDir) return null;
      var parts = relPath.replace(/^\/+/, '').split('/');
      if (parts[0] !== 'images') return null;
      var dir = state.imagesDir;
      try {
        for (var i = 1; i < parts.length - 1; i++) {
          dir = await dir.getDirectoryHandle(parts[i]);
        }
        var fh = await dir.getFileHandle(parts[parts.length - 1]);
        return await fh.getFile();
      } catch (e) {
        return null;
      }
    },

    /** 把图片写进 source/images/YYYY/MM/ */
    async saveImage(file, preferDate) {
      // 用 toString 判断，避免跨 realm（iframe/测试环境）时 instanceof 失效
      var isDate = preferDate && Object.prototype.toString.call(preferDate) === '[object Date]';
      var d = isDate ? preferDate : new Date();
      var yyyy = String(d.getFullYear());
      var mm = ('0' + (d.getMonth() + 1)).slice(-2);
      var dir = state.imagesDir;
      if (!dir) throw new Error('没有连接 source/images 目录');
      dir = await dir.getDirectoryHandle(yyyy, { create: true });
      dir = await dir.getDirectoryHandle(mm, { create: true });
      var ext = fileExt(file.name);
      var name = randomImageName(ext);
      // 极低概率撞名：撞了就重抽
      for (var i = 0; i < 20; i++) {
        try { await dir.getFileHandle(name); } catch (e) { break; }
        name = randomImageName(ext);
      }
      var fh = await dir.getFileHandle(name, { create: true });
      var w = await fh.createWritable();
      await w.write(file);
      await w.close();
      return '/images/' + yyyy + '/' + mm + '/' + name;
    }
  };

  /* ================================================================
   * 4. 列表
   * ================================================================ */
  function reindex() {
    var tags = new Map();
    state.posts.forEach(function (p) {
      var t = Core.get(p.doc, 'tags');
      (Array.isArray(t) ? t : []).forEach(function (x) {
        tags.set(x, (tags.get(x) || 0) + 1);
      });
    });
    state.allTags = tags;
    renderTagFilter();
    renderList();
  }
  FS.reindex = reindex;

  function renderTagFilter() {
    var box = $('#tag-filter');
    box.innerHTML = '';
    var entries = Array.from(state.allTags.entries()).sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });
    entries.forEach(function (pair) {
      var tag = pair[0];
      var b = el('button', {
        class: 'tagbtn' + (state.filter.tags.indexOf(tag) !== -1 ? ' on' : ''),
        text: tag + ' ' + pair[1],
        onclick: function () {
          var i = state.filter.tags.indexOf(tag);
          if (i === -1) state.filter.tags.push(tag);
          else state.filter.tags.splice(i, 1);
          renderTagFilter();
          renderList();
        }
      });
      box.appendChild(b);
    });
  }

  function postTitle(p) {
    var t = String(Core.get(p.doc, 'title') || '').trim();
    return t || p.name.replace(/\.md$/i, '');
  }

  function matches(p) {
    var f = state.filter;
    if (f.dirtyOnly && !p.dirty) return false;
    if (f.tags.length) {
      var tags = Core.get(p.doc, 'tags') || [];
      for (var i = 0; i < f.tags.length; i++) if (tags.indexOf(f.tags[i]) === -1) return false;
    }
    if (f.q) {
      var q = f.q.toLowerCase();
      var hay = (postTitle(p) + ' ' + p.name + ' ' + (Core.get(p.doc, 'tags') || []).join(' ')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  function sortedPosts() {
    var arr = state.posts.filter(matches);
    var s = state.filter.sort;
    arr.sort(function (a, b) {
      if (s === 'name') return a.name.localeCompare(b.name, 'zh-CN');
      var da = Core.parseDate(Core.get(a.doc, 'date'));
      var db = Core.parseDate(Core.get(b.doc, 'date'));
      var ta = da ? da.getTime() : 0;
      var tb = db ? db.getTime() : 0;
      return s === 'date-asc' ? ta - tb : tb - ta;
    });
    return arr;
  }

  function renderList() {
    var list = $('#post-list');
    list.innerHTML = '';
    var posts = sortedPosts();
    posts.forEach(function (p) {
      var date = String(Core.get(p.doc, 'date') || '').slice(0, 10);
      var tags = Core.get(p.doc, 'tags') || [];
      var li = el('li', {
        class: (state.current && state.current.id === p.id ? 'active ' : '') + (p.dirty ? 'dirty' : ''),
        onclick: function () { openPost(p); }
      }, [
        el('div', { class: 'p-title', text: postTitle(p) }),
        el('div', { class: 'p-meta' }, [
          el('span', { text: date || '无日期' }),
          el('span', { class: 'p-tags', text: tags.slice(0, 3).join(' / ') })
        ])
      ]);
      list.appendChild(li);
    });
    $('#count-info').textContent = posts.length + ' / ' + state.posts.length + ' 篇';
    if (!posts.length) {
      list.appendChild(el('li', { class: 'p-empty', text: '没有匹配的文章' }));
    }
  }

  /* ================================================================
   * 5. 编辑器：打开 / 关闭
   * ================================================================ */
  var form = {};
  var suppress = false;

  function cacheForm() {
    ['title', 'abbrlink', 'description', 'date', 'cover'].forEach(function (k) {
      form[k] = $('#f-' + k);
    });
    form.tagsInput = $('#f-tags-input');
    form.tagsChips = $('#tags-chips');
    form.fileName = $('#file-name');
    form.body = $('#body');
    bodyEl = form.body;
  }

  function closeEditor() {
    state.current = null;
    state.sidebarCollapsed = false;
    renderList();
    refreshMainView();
  }

  function openPost(p, opts) {
    opts = opts || {};
    commitCurrentDraft();
    state.current = p;
    suppress = true;
    $('#empty').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    form.fileName.value = p.name;
    form.title.value = String(Core.get(p.doc, 'title') || '');
    form.abbrlink.value = String(Core.get(p.doc, 'abbrlink') || '');
    form.description.value = String(Core.get(p.doc, 'description') || '');
    form.date.value = String(Core.get(p.doc, 'date') || '');
    form.cover.value = String(Core.get(p.doc, 'cover') || '');
    renderBody(p.doc.body);
    renderChips();
    applyLocks();
    updateCoverPreview();
    if (opts.keepDirty) p.dirty = true;
    updateDirtyUI();
    updateStats();
    updateCursor();
    renderFrontMatter();
    validateAndShow();
    suppress = false;
    renderList();
    if (!opts.skipDraftCheck) checkDraft(p);
    // 打开文章后侧栏自动收起，把宽度让给编辑区
    state.sidebarCollapsed = true;
    refreshMainView();
    bodyEl.focus();
    setCaret(0);
    syncActiveLine();
    hist = []; histIdx = -1; pushHistory();
  }

  /** 日期 / abbrlink 的锁定规则 */
  function applyLocks() {
    if (!state.current) return;
    var abbr = String(Core.get(state.current.doc, 'abbrlink') || '').trim();
    var abbrUnlocked = !!abbr || state.current.forceAbbrlink;
    form.abbrlink.disabled = !abbrUnlocked;
    $('#lock-abbrlink').textContent = abbrUnlocked ? '🔓' : '🔒';
    $('#lock-abbrlink').classList.toggle('unlocked', abbrUnlocked);
    $('#lock-abbrlink').title = abbrUnlocked
      ? (abbr ? '已从文件读到 abbrlink，可编辑' : '已手动解锁')
      : '锁定：hexo generate 会自动写入 abbrlink，之后点 ↻ 重新读取即可编辑';

    var dateUnlocked = !!state.current.savedOnce;
    form.date.disabled = !dateUnlocked;
    $('#lock-date').textContent = dateUnlocked ? '🔓' : '🔒';
    $('#lock-date').classList.toggle('unlocked', dateUnlocked);
    $('#lock-date').title = dateUnlocked ? '可编辑' : '锁定：文件保存一次后才可修改日期';
  }

  /* ================================================================
   * 6. 表单 → doc
   * ================================================================ */
  function markDirty() {
    var p = state.current;
    if (!p || suppress) return;
    p.dirty = true;
    updateDirtyUI();
    renderList();
    scheduleDraft();
    renderFrontMatter();
    validateAndShow();
  }

  function updateDirtyUI() {
    var p = state.current;
    $('#dirty-dot').classList.toggle('on', !!(p && p.dirty));
    var s = $('#save-state');
    if (!p) { s.textContent = '—'; s.className = 'save-state'; return; }
    if (p.dirty) { s.textContent = '未保存'; s.className = 'save-state dirty'; }
    else { s.textContent = '已保存'; s.className = 'save-state saved'; }
  }

  function setField(key, value) {
    if (!state.current) return;
    Core.set(state.current.doc, key, value);
    markDirty();
  }

  /* ---- tags ---- */
  function renderChips() {
    var tags = Core.get(state.current.doc, 'tags') || [];
    var box = form.tagsChips;
    box.innerHTML = '';
    tags.forEach(function (t, i) {
      box.appendChild(el('span', { class: 'chip' }, [
        el('span', { text: t }),
        el('button', {
          type: 'button', text: '×', title: '移除',
          onclick: function () {
            var arr = (Core.get(state.current.doc, 'tags') || []).slice();
            arr.splice(i, 1);
            setField('tags', arr);
            renderChips();
          }
        })
      ]));
    });
    renderSuggest();
  }

  function renderSuggest() {
    var box = $('#tag-suggest');
    box.innerHTML = '';
    if (!state.allTags) return;
    var have = Core.get(state.current.doc, 'tags') || [];
    var q = form.tagsInput.value.trim().toLowerCase();
    var candidates = Array.from(state.allTags.keys())
      .filter(function (t) { return have.indexOf(t) === -1 && (!q || t.toLowerCase().indexOf(q) !== -1); })
      .sort(function (a, b) { return state.allTags.get(b) - state.allTags.get(a); })
      .slice(0, 14);
    candidates.forEach(function (t) {
      box.appendChild(el('button', {
        type: 'button', text: '+ ' + t, title: '点击添加',
        onclick: function () { addTag(t); }
      }));
    });
  }

  function addTag(raw) {
    var parts = String(raw).split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return;
    var arr = (Core.get(state.current.doc, 'tags') || []).slice();
    parts.forEach(function (t) { if (arr.indexOf(t) === -1) arr.push(t); });
    setField('tags', arr);
    form.tagsInput.value = '';
    renderChips();
  }

  /* ---- cover ---- */
  function updateCoverPreview() {
    var box = $('#cover-preview');
    var path = String(form.cover.value || '').trim();
    if (!path) {
      box.textContent = '无封面';
      box.classList.remove('has-img');
      box.style.backgroundImage = '';
      return;
    }
    box.textContent = '加载中…';
    resolveImageUrl(path).then(function (url) {
      if (!url) {
        box.textContent = '无法预览';
        box.classList.remove('has-img');
        box.style.backgroundImage = '';
        return;
      }
      box.textContent = '';
      box.classList.add('has-img');
      box.style.backgroundImage = 'url("' + url + '")';
    });
  }

  /**
   * 把站内路径解析成能显示的 URL。
   * 三种来源，按优先级：
   *   1) 已连接 images 目录 → 读文件做 blob URL（最可靠，任何协议都行）
   *   2) http(s) 环境 → 直接用 /images/... 交给服务器映射
   *   3) file:// 且没连目录 → 用相对路径 ../source/images/... 直接读文件系统
   */
  function resolveImageUrl(path) {
    if (!path) return Promise.resolve('');
    path = String(path).trim();
    if (/^https?:/i.test(path)) return Promise.resolve(path);
    if (state.imageCache.has(path)) return Promise.resolve(state.imageCache.get(path));
    if (path.charAt(0) !== '/') return Promise.resolve('');

    function viaRelative() {
      if (location.protocol !== 'file:') return null;
      // file:// 下浏览器允许直接读同源文件；编辑器在 hexo-editor/，图片在 ../source/images/
      return '../source' + path;
    }

    if (!state.hasImages) {
      var rel = viaRelative();
      return Promise.resolve(rel || (location.protocol === 'file:' ? '' : path));
    }
    return FS.readImage(path).then(function (file) {
      if (!file) return viaRelative() || (location.protocol === 'file:' ? '' : path);
      var url = URL.createObjectURL(file);
      state.imageCache.set(path, url);
      return url;
    }).catch(function () {
      return viaRelative() || (location.protocol === 'file:' ? '' : path);
    });
  }

  /** 把选中的图片写入 source/images 并返回站内路径 */
  async function importImage(file) {
    if (!state.hasImages) {
      var fake = '/images/' + new Date().getFullYear() + '/' + ('0' + (new Date().getMonth() + 1)).slice(-2) + '/' +
        randomImageName(fileExt(file.name));
      // 能连图片目录的话，直接给个一键连接的机会，别让用户干瞪眼
      var go = hasFSA ? await openModal({
        title: '还没连接图片目录',
        body: '<p class="tip">图片要存进 <code>source/images/YYYY/MM/</code> 才能正常显示，' +
          '但现在编辑器还不知道它在哪里。</p>' +
          '<p class="tip">点「连接图片目录」会把这张图存进去并自动填好路径；' +
          '选「只填路径」则只写 Markdown，图片需要你自己放过去。</p>',
        actions: [
          { label: '只填路径', value: 'path' },
          { label: '连接图片目录', primary: true, value: 'pick' }
        ]
      }) : 'path';

      if (go === 'pick') {
        await pickImagesFlow();
        if (state.hasImages) return importImage(file); // 连上了就重跑一次
      }
      toast('仅填了路径，请手动把图片放到 source' + fake, 'err');
      return fake;
    }
    try {
      var path = await FS.saveImage(file);
      toast('图片已保存到 source' + path, 'ok');
      return path;
    } catch (e) {
      toast('保存图片失败：' + e.message, 'err');
      return '';
    }
  }

  /* ================================================================
   * 7. 校验 & Front Matter 预览
   * ================================================================ */
  function validateAndShow() {
    if (!state.current) return;
    var issues = Core.validate(state.current.doc);
    $$('.msg').forEach(function (m) { m.textContent = ''; m.className = 'msg'; });
    $$('.field').forEach(function (f) { f.classList.remove('invalid'); });
    issues.forEach(function (i) {
      var m = document.querySelector('.msg[data-for="' + i.field + '"]');
      if (m) {
        m.textContent = i.message;
        m.className = 'msg' + (i.level === 'error' ? ' error' : '');
        var field = m.closest('.field');
        if (field && i.level === 'error') field.classList.add('invalid');
      }
    });
    return issues;
  }

  function renderFrontMatter() {
    if (!state.current) return;
    var text = Core.stringifyPost(state.current.doc);
    var split = Core.splitFront(text);
    $('#frontmatter-view').textContent = split.hasFront
      ? '---\n' + split.front.join('\n') + '\n---'
      : '(无 front matter)';
  }

  /* ================================================================
   * 8. 正文编辑（所见即所得，但底层仍是纯文本 markdown）
   *
   * 模型：bodyEl 里「一行一个 div」，每行 textContent 就是该行的原始
   * markdown。光标所在行保持原文（.editing），其余行做渲染 —— 标题变大、
   * 标记隐藏、行内格式生效。这样保存时逐字节不变，打字时又能立刻看到
   * 块级效果；回车/退格/粘贴/撤销都自己接管，不依赖 execCommand。
   * ================================================================ */
  var bodyEl = null;
  var activeLine = null;      // 当前正在编辑（保持原文）的那一行
  var composing = false;      // 输入法组字中：不做任何 DOM 手术
  var lastAbs = 0;            // 最近一次光标位置（焦点离开正文后仍可用）
  var hist = [];
  var histIdx = -1;
  var keepHistory = false;    // 撤销/重做回放时不要再记历史

  var LINE_RE = {
    fence: /^\s{0,3}(```|~~~)/,
    atx: /^\s{0,3}(#{1,6})\s+/,
    quote: /^\s{0,3}>\s?/,
    task: /^(\s{0,3})([-*+])\s+\[[ xX]\]\s+/,
    ul: /^(\s{0,3})[-*+]\s+/,
    ol: /^(\s{0,3})(\d+)([.)])\s+/,
    indent: /^( {4}|\t)/,
    htmlBlock: /^\s{0,3}<(div|script|iframe|table|center|details|p|img|br)\b/i
  };

  /** 判定一行属于哪种块（fence 状态跨行传递） */
  function lineType(text, st) {
    if (!text.trim()) return st.inFence ? 'code' : 'p';
    if (LINE_RE.fence.test(text)) { st.inFence = !st.inFence; return 'fence'; }
    if (st.inFence) return 'code';
    var m = LINE_RE.atx.exec(text);
    if (m) return 'h' + m[1].length;
    if (LINE_RE.task.test(text)) return /\[[xX]\]/.test(text) ? 'task-done' : 'task';
    if (LINE_RE.ul.test(text)) return 'ul';
    if (LINE_RE.ol.test(text)) return 'ol';
    if (LINE_RE.quote.test(text)) return 'quote';
    if (LINE_RE.indent.test(text)) return 'code';
    if ((text.replace(/\s/g, '').match(/^([-*_])(\1){2,}$/))) return 'hr';
    if (/^\s{0,3}\|/.test(text)) return 'table';
    if (LINE_RE.htmlBlock.test(text)) return 'html';
    return 'p';
  }

  function lineEls() {
    return bodyEl ? Array.prototype.slice.call(bodyEl.children) : [];
  }

  /** 一行的纯文本（把 nbsp 还原成空格、把 <br> 还原成 \n，避免存盘时丢字符） */
  function textOf(node) {
    if (node.querySelector && node.querySelector('br')) {
      var parts = [];
      Array.prototype.forEach.call(node.childNodes, function (c) {
        if (c.nodeName === 'BR') parts.push('\n');
        else parts.push(c.textContent || '');
      });
      return parts.join('').replace(/\u00a0/g, ' ');
    }
    return String(node.textContent || '').replace(/\u00a0/g, ' ');
  }

  /** 某一行里混进了换行（浏览器偶尔会这么干）→ 要重新按行拆一次 */
  function hasStrayNewline() {
    return lineEls().some(function (l) { return textOf(l).indexOf('\n') !== -1; });
  }

  function bodyText() {
    return lineEls().map(textOf).join('\n');
  }

  /** (节点, 偏移) → 整篇里的绝对字符偏移；不在正文里返回 -1 */
  function absOf(container, offset) {
    if (!bodyEl) return -1;
    var lines = lineEls();
    if (container === bodyEl) {
      var idx = Math.max(0, Math.min(offset, lines.length - 1));
      var p0 = 0;
      for (var k = 0; k < idx; k++) p0 += textOf(lines[k]).length + 1;
      return p0;
    }
    var pos = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.contains(container)) {
        var total = 0;
        var done = false;
        (function walk(n) {
          if (done) return;
          if (n === container) {
            if (n.nodeType === 3) total += Math.min(offset, n.nodeValue.length);
            else for (var j = 0; j < offset && j < n.childNodes.length; j++) total += (n.childNodes[j].textContent || '').length;
            done = true;
            return;
          }
          if (n.nodeType === 3) { total += n.nodeValue.length; return; }
          for (var c = 0; c < n.childNodes.length; c++) walk(n.childNodes[c]);
        })(line);
        return pos + total;
      }
      pos += textOf(line).length + 1;
    }
    return -1;
  }

  /** 当前选区（绝对偏移）；焦点不在正文时退回上次的位置 */
  function selInfo() {
    var s = window.getSelection();
    if (!s || !s.rangeCount || !bodyEl) return null;
    var r = s.getRangeAt(0);
    var a = absOf(r.startContainer, r.startOffset);
    var b = absOf(r.endContainer, r.endOffset);
    if (a < 0 || b < 0) return null;
    return a <= b ? { a: a, b: b } : { a: b, b: a };
  }

  function locate(abs) {
    var lines = lineEls();
    if (!lines.length) return null;
    var pos = 0;
    for (var i = 0; i < lines.length; i++) {
      var len = textOf(lines[i]).length;
      if (abs <= pos + len) return { el: lines[i], off: abs - pos };
      pos += len + 1;
    }
    var last = lines[lines.length - 1];
    return { el: last, off: textOf(last).length };
  }

  function pointIn(el, off) {
    var remain = off, lastText = null;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (remain <= n.nodeValue.length) return { node: n, offset: remain };
      remain -= n.nodeValue.length;
      lastText = n;
    }
    if (lastText) return { node: lastText, offset: lastText.nodeValue.length };
    return { node: el, offset: 0 };
  }

  function setCaret(a, b) {
    if (b == null) b = a;
    var s1 = locate(a), s2 = locate(b);
    if (!s1 || !s2) return;
    var p1 = pointIn(s1.el, s1.off), p2 = pointIn(s2.el, s2.off);
    var range = document.createRange();
    try {
      range.setStart(p1.node, p1.offset);
      range.setEnd(p2.node, p2.offset);
    } catch (e) { return; }
    if (bodyEl && document.activeElement !== bodyEl) { try { bodyEl.focus(); } catch (e) { /* 忽略 */ } }
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    lastAbs = a;
  }

  /* ---------------- 行内渲染 ---------------- */
  var INLINE_RE = new RegExp(
    '(`[^`\\n]+`)' +                                   // 1 行内代码
    '|\\*\\*([^*\\n]+)\\*\\*' +                        // 2 粗体
    '|__([^_\\n]+)__' +                                // 3 粗体
    '|~~([^~\\n]+)~~' +                                // 4 删除线
    '|\\*([^*\\n]+)\\*' +                              // 5 斜体
    '|!\\[([^\\]\\n]*)\\]\\(([^)\\n]*)\\)' +           // 6/7 图片
    '|\\[([^\\]\\n]+)\\]\\(([^)\\n]*)\\)',             // 8/9 链接
    'g'
  );

  /** 图片预览节点：<img> 的 textContent 恒为空串，不影响读回原文 */
  function imgNode(src) {
    var img = document.createElement('img');
    img.className = 'ed-img';
    img.setAttribute('data-src', String(src || ''));
    img.alt = '';
    return img;
  }

  var IMG_PENDING = Object.create(null);

  /** 给渲染出来、但还没拿到真实地址的 <img> 补上 src（异步，逐张） */
  function hydrateImages(root) {
    var scope = root && root.querySelectorAll ? root : bodyEl;
    if (!scope) return;
    var imgs = scope.querySelectorAll('img.ed-img[data-src]');
    Array.prototype.forEach.call(imgs, function (img) {
      if (img.getAttribute('data-done')) return;
      img.setAttribute('data-done', '1');
      var src = img.getAttribute('data-src');
      if (!src) { markImgBad(img); return; }
      Promise.resolve(resolveImageUrl(src)).then(function (url) {
        if (!url || !img.isConnected) { markImgBad(img); return; }
        img.addEventListener('load', function () {
          if (!img.naturalWidth) markImgBad(img);
          else img.classList.add('ok');
        }, { once: true });
        img.addEventListener('error', function () { markImgBad(img); }, { once: true });
        img.src = url;
      }).catch(function () { markImgBad(img); });
    });
  }

  /** 图加载不出来时退回原来的「🖼 alt」小徽标，别让人对着一片空白 */
  function markImgBad(img) {
    img.classList.add('bad');
    var prev = img.previousElementSibling;
    if (prev && prev.getAttribute && prev.getAttribute('data-i') === 'img') {
      prev.classList.add('show-fallback');
    }
  }

  /* ---------------- 表格 ---------------- */

  /** `| a | b |` → ['a', 'b']（首尾竖线可有可无） */
  function splitCells(text) {
    var s = String(text == null ? '' : text).trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (c) { return c.trim(); });
  }

  /** `|---|:--:|` 这种分隔行 */
  function isSepRow(cells) {
    if (!cells.length) return false;
    return cells.every(function (c) { return /^:?-{2,}:?$/.test(c.trim()); });
  }

  function alignOfCell(c) {
    var s = c.trim();
    var l = s.charAt(0) === ':';
    var r = s.charAt(s.length - 1) === ':';
    return l && r ? 'center' : r ? 'right' : '';
  }

  /**
   * 一个表格块的「列数 / 每列对齐」。
   * 每行渲染时自己算一遍（而不是统一刷一遍全表），这样单独重绘某一行
   * 也不会把对齐丢掉 —— 早期版本挂在批量刷新上，光标挪动重绘表头后就丢了。
   */
  function tableBlockInfo(lineEl, selfText) {
    var start = lineEl;
    while (start.previousElementSibling &&
           start.previousElementSibling.getAttribute('data-t') === 'table') {
      start = start.previousElementSibling;
    }
    var cols = 2, align = null, n = start;
    while (n && n.getAttribute('data-t') === 'table') {
      var cs = splitCells(n === lineEl && selfText != null ? selfText : textOf(n));
      cols = Math.max(cols, cs.length);
      if (!align && isSepRow(cs)) align = cs.map(alignOfCell);
      n = n.nextElementSibling;
    }
    return { cols: cols, align: align };
  }

  /**
   * 表格行视觉化。约束同样是 textContent 不能变：
   * 原文放进隐藏 span，单元格文字由 `.tc::before { content: attr(data-c) }`
   * 渲染 —— 伪元素产生的文字不算 textContent，所以读回来还是 `| a | b |`。
   */
  function renderTableLine(lineEl, raw) {
    var cells = splitCells(raw);
    var sep = isSepRow(cells);
    var prev = lineEl.previousElementSibling;
    var head = !sep && !(prev && prev.getAttribute('data-t') === 'table');
    var info = tableBlockInfo(lineEl, raw);
    lineEl.appendChild(el('span', { class: 'ed-i', 'data-i': 'mk', text: raw }));
    var cursor = 0;
    if (sep) {
      lineEl.setAttribute('data-sep', '1');
      lineEl.removeAttribute('data-head');
    } else {
      lineEl.removeAttribute('data-sep');
      if (head) lineEl.setAttribute('data-head', '1');
      else lineEl.removeAttribute('data-head');
      cells.forEach(function (c, idx) {
        var at = raw.indexOf(c, cursor);
        if (at < 0) at = cursor;
        cursor = at + c.length;
        var cell = el('span', { class: 'tc', 'data-c': c, 'data-at': String(at) });
        var al = info.align && info.align[idx];
        if (al) cell.setAttribute('data-al', al);
        lineEl.appendChild(cell);
      });
    }
    lineEl.style.setProperty('--cols', info.cols);
  }

  /* ---------------- 视频块 ---------------- */

  /** 视频块两种形态：
   *  1) 自动选择（判断网络）：`<div id="videoContainer">…</div><script>…</script>` 多行；
   *  2) 二选一（固定平台）：单行 iframe（`<div …><iframe …></div>` 或 `<iframe …>`）。 */
  function isVideoContainer(text) {
    return /^\s*<div\s+id=["']?videoContainer/i.test(text);
  }
  function isVideoEnd(text) {
    return /^\s*<\/script>\s*$/i.test(text);
  }
  function hasVideoIframe(text) {
    return /player\.bilibili\.com\/player\.html|youtube\.com\/embed/.test(text);
  }

  /** 遍历行，给视频块打标记：data-vblock=1（块内所有行）、data-vhead=1（首行） */
  function refreshVideoBlocks() {
    var lines = lineEls();
    lines.forEach(function (l) { l.removeAttribute('data-vblock'); l.removeAttribute('data-vhead'); });
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var t = line.getAttribute('data-t');
      var txt = textOf(line);
      // 代码块（fence / 缩进代码）里的示例代码不算真视频块，跳过
      var inCode = t === 'code' || t === 'fence';
      if (!inCode && isVideoContainer(txt)) {
        var j = i;
        while (j < lines.length && !isVideoEnd(textOf(lines[j]))) j++;
        if (j < lines.length) {
          for (var k = i; k <= j; k++) lines[k].setAttribute('data-vblock', '1');
          lines[i].setAttribute('data-vhead', '1');
          i = j + 1;
          continue;
        }
      } else if (!inCode && hasVideoIframe(txt)) {
        lines[i].setAttribute('data-vblock', '1');
        lines[i].setAttribute('data-vhead', '1');
      }
      i++;
    }
  }

  /** 从视频块里解析出第一个 iframe 地址（哔哩哔哩优先，便于国内直接预览） */
  function resolveVideoSrc(lineEl) {
    var buf = [];
    var n = lineEl;
    var multi = isVideoContainer(textOf(lineEl));
    while (n) {
      buf.push(textOf(n));
      if (multi ? isVideoEnd(textOf(n)) : true) break;
      n = n.nextElementSibling;
    }
    var all = buf.join('\n');
    var m = /player\.bilibili\.com\/player\.html[^"'\s]*/.exec(all);
    if (m) return 'https://' + m[0];
    m = /youtube\.com\/embed\/[^"'\s]+/.exec(all);
    if (m) return 'https://www.' + m[0];
    return '';
  }

  /** 视频块首行渲染：原文留在隐藏 span（保证 textContent 不变），另配一个 iframe 预览 */
  function renderVideoPreview(lineEl, raw) {
    lineEl.appendChild(el('span', { class: 'ed-i', 'data-i': 'mk', text: raw }));
    var src = resolveVideoSrc(lineEl);
    if (src) {
      var wrap = el('div', { class: 'ed-video' });
      wrap.appendChild(el('iframe', {
        src: src,
        frameborder: '0',
        scrolling: 'no',
        allowfullscreen: 'true',
        title: '视频播放器预览'
      }));
      lineEl.appendChild(wrap);
    } else {
      lineEl.appendChild(el('span', { class: 'ed-video-badge', text: '▶ 视频播放器' }));
    }
  }

  /** 光标进/出视频块时折叠/展开：折叠态只显示首行 iframe，展开态显示全部源码 */
  function updateVideoBlockState(line) {
    var inBlock = !!(line && line.getAttribute && line.hasAttribute('data-vblock'));
    if (bodyEl.classList.contains('vblock-open') === inBlock) return;
    bodyEl.classList.toggle('vblock-open', inBlock);
    lineEls().forEach(function (l) {
      if (l.hasAttribute('data-vhead') && l !== activeLine) decorateLine(l);
    });
  }

  /**
   * 行内渲染。关键约束：渲染出来的 DOM 的 textContent 必须和原始 markdown
   * 一字不差 —— 标记（`**`、`[`、`](url)` …）都保留成被 CSS 隐藏的 span，
   * 所以 bodyText() 读回来还是原始文本，存盘不会丢字符。
   */
  function pushInline(box, text) {
    function mk(s) { if (s) box.appendChild(el('span', { class: 'ed-i', 'data-i': 'mk', text: s })); }
    function span(kind, s) { box.appendChild(el('span', { class: 'ed-i', 'data-i': kind, text: s })); }
    INLINE_RE.lastIndex = 0;
    var last = 0, m;
    while ((m = INLINE_RE.exec(text))) {
      if (m.index > last) box.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) { mk('`'); span('code', m[1].slice(1, -1)); mk('`'); }
      else if (m[2]) { mk('**'); span('b', m[2]); mk('**'); }
      else if (m[3]) { mk('__'); span('b', m[3]); mk('__'); }
      else if (m[4]) { mk('~~'); span('s', m[4]); mk('~~'); }
      else if (m[5]) { mk('*'); span('i', m[5]); mk('*'); }
      else if (m[6] != null) {
        // alt 文本用 <span> 留住（textContent 必须一字不差），真图另配一个 <img>：
        // <img> 的 textContent 是空串，不影响读回原文
        mk('!['); span('img', m[6]); mk('](' + m[7] + ')');
        box.appendChild(imgNode(m[7]));
      }
      else if (m[8] != null) { mk('['); span('a', m[8]); mk('](' + m[9] + ')'); }
      last = m.index + m[0].length;
    }
    if (last < text.length) box.appendChild(document.createTextNode(text.slice(last)));
  }

  /** 整行只有一张图片？→ 走大图预览 */
  var IMG_ONLY_RE = /^!\[[^\]\n]*\]\([^)\n]*\)$/;

  /** 把一行渲染成「去标记」的样子（光标不在这一行时才调用） */
  function decorateLine(lineEl) {
    if (!lineEl) return;
    var raw = textOf(lineEl);
    var t = lineEl.getAttribute('data-t') || 'p';
    lineEl.classList.remove('editing');
    lineEl.textContent = '';
    lineEl.classList.remove('img-only');
    if (t === 'table') { renderTableLine(lineEl, raw); return; }
    // 视频块首行：折叠态渲染 iframe 预览；展开态（光标在块内）显示源码
    if (lineEl.hasAttribute('data-vhead') && !bodyEl.classList.contains('vblock-open')) {
      renderVideoPreview(lineEl, raw);
      return;
    }
    var text = raw;
    var marker = '', m;
    if (t.charAt(0) === 'h' && (m = LINE_RE.atx.exec(text))) { marker = m[0]; text = text.slice(m[0].length); }
    else if (t === 'quote' && (m = LINE_RE.quote.exec(text))) { marker = m[0]; text = text.slice(m[0].length); }
    else if ((t === 'ul' || t === 'task' || t === 'task-done') && (m = LINE_RE.task.exec(text) || LINE_RE.ul.exec(text))) {
      marker = m[0]; text = text.slice(m[0].length);
    }
    if (marker) lineEl.appendChild(el('span', { class: 'ed-i', 'data-i': 'mk', text: marker }));
    // 代码块/HTML 行不做行内渲染（避免把里面的反引号、星号当成格式）
    if (t === 'code' || t === 'fence' || t === 'html' || t === 'hr') {
      lineEl.appendChild(document.createTextNode(text));
    } else {
      if (IMG_ONLY_RE.test(text.trim())) lineEl.classList.add('img-only');
      pushInline(lineEl, text);
      hydrateImages(lineEl);
    }
  }

  function decorateAll() {
    refreshVideoBlocks();
    lineEls().forEach(function (l) {
      if (l !== activeLine) decorateLine(l);
    });
  }

  function refreshTypes() {
    var st = { inFence: false };
    lineEls().forEach(function (l) {
      var t = lineType(textOf(l), st);
      if (l.getAttribute('data-t') !== t) l.setAttribute('data-t', t);
    });
  }

  /** 光标行保持原文；换行时把上一行还原成渲染态 */
  function syncActiveLine() {
    if (!bodyEl) return;
    var info = selInfo();
    if (!info) return;
    // 非折叠选区（正在拖选文字）期间不做任何 DOM 手术：
    // activeLine 切换 + textContent 重建会销毁选区所在的文本节点，
    // 打断浏览器原生拖选 —— 表现就是「从下往上选不动」（anchor 在下时
    // info.a 是文档起点、落在上方行，反复触发重建），从上往下却正常。
    // 只有纯光标（折叠选区）才需要把所在行切回源码态。
    if (info.a !== info.b) { lastAbs = info.a; return; }
    var loc = locate(info.a);
    if (!loc) { lastAbs = info.a; return; }
    updateVideoBlockState(loc.el);   // 光标进/出视频块时折叠/展开
    if (loc.el === activeLine) { lastAbs = info.a; return; }
    var abs = info.a, end = info.b;
    var prev = activeLine;
    activeLine = loc.el;
    if (prev) decorateLine(prev);
    activeLine.classList.add('editing');
    activeLine.textContent = textOf(activeLine);   // 去掉装饰，回到原始 markdown
    setCaret(abs, end > abs ? end : undefined);
  }

  function renderBody(text, caretA, caretB) {
    if (!bodyEl) return;
    suppress = true;
    bodyEl.innerHTML = '';
    var st = { inFence: false };
    String(text == null ? '' : text).split('\n').forEach(function (t) {
      var d = document.createElement('div');
      d.className = 'cl';
      d.setAttribute('data-t', lineType(t, st));
      d.textContent = t;
      bodyEl.appendChild(d);
    });
    activeLine = null;
    suppress = false;
    decorateAll();
    if (caretA != null) { setCaret(caretA, caretB); syncActiveLine(); }
    else { lastAbs = bodyText().length; }
  }

  /* ---------------- 历史（自建撤销栈） ---------------- */
  function snap() {
    var info = selInfo();
    return { text: bodyText(), a: info ? info.a : lastAbs };
  }

  function pushHistory() {
    if (!bodyEl || !state.current) return;
    var s = snap();
    if (hist[histIdx] && hist[histIdx].text === s.text) return;
    hist = hist.slice(0, histIdx + 1);
    hist.push(s);
    if (hist.length > 120) { hist.shift(); }
    histIdx = hist.length - 1;
  }

  function jumpHistory(dir) {
    var next = histIdx + dir;
    if (next < 0 || next >= hist.length) return;
    histIdx = next;
    keepHistory = true;
    renderBody(hist[histIdx].text, hist[histIdx].a);
    onBodyInput();
    keepHistory = false;
  }

  /* ---------------- 文本操作（都基于绝对偏移） ---------------- */
  function applyText(next, selA, selB) {
    renderBody(next, selA, selB);
    onBodyInput();
  }

  function replaceSel(text, selA, selB) {
    var info = selInfo() || { a: lastAbs, b: lastAbs };
    var v = bodyText();
    var next = v.slice(0, info.a) + text + v.slice(info.b);
    var caret = info.a + text.length;
    applyText(next,
      selA != null ? selA : caret,
      selB != null ? selB : (selA != null ? selA : caret));
  }

  function insertText(text, selectOffset) {
    replaceSel(text,
      selectOffset ? selectOffset[0] : null,
      selectOffset ? selectOffset[1] : null);
  }

  /** 用 before/after 包裹选区 */
  function wrap(before, after, placeholder) {
    var info = selInfo() || { a: lastAbs, b: lastAbs };
    var v = bodyText();
    var sel = v.slice(info.a, info.b) || placeholder || '';
    var start = info.a + before.length;
    var next = v.slice(0, info.a) + before + sel + after + v.slice(info.b);
    applyText(next, start, start + sel.length);
  }

  /** 给选中的每一行加前缀 */
  function prefixLines(prefix, numbered) {
    var info = selInfo() || { a: lastAbs, b: lastAbs };
    var v = bodyText();
    var lineStart = v.lastIndexOf('\n', info.a - 1) + 1;
    var lineEnd = v.indexOf('\n', info.b);
    if (lineEnd === -1) lineEnd = v.length;
    var out = v.slice(lineStart, lineEnd).split('\n').map(function (line, i) {
      var p = numbered ? (i + 1) + '. ' : prefix;
      if (line.indexOf(p) === 0) return line; // 已经有前缀 → 不改
      return p + line;
    }).join('\n');
    var next = v.slice(0, lineStart) + out + v.slice(lineEnd);
    applyText(next, lineStart, lineStart + out.length);
  }

  /**
   * 在独立行插入块级内容（不吞掉已有选区，插到选区末尾所在行）
   * caretAfter=true → 光标落到插入内容之后的那一行，让块（表格/图片）
   * 立刻进入渲染态，不用先点别处才看得见效果
   */
  function insertBlock(text, caretAfter) {
    var info = selInfo() || { a: lastAbs, b: lastAbs };
    var v = bodyText();
    var s = info.b;
    var lineStart = v.lastIndexOf('\n', s - 1) + 1;
    var needBefore = lineStart !== s && s !== 0 ? '\n' : '';
    var rest = v.slice(s);
    var needAfter = rest === '' || rest.charAt(0) !== '\n' ? '\n' : '';
    var payload = needBefore + text + needAfter;
    var next = v.slice(0, s) + payload + v.slice(s);
    var start = s + needBefore.length;
    if (!caretAfter) { applyText(next, start, start + text.length); return; }
    var after = s + payload.length;
    if (next.charAt(after) === '\n') after += 1;
    applyText(next, after);
  }

  var TABLE_TPL = '| 列 1 | 列 2 | 列 3 |\n|:---|:---:|---:|\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |';

  function action(name) {
    var ta = form.body;
    switch (name) {
      case 'bold': return wrap('**', '**', '加粗文字');
      case 'italic': return wrap('*', '*', '斜体文字');
      case 'strike': return wrap('~~', '~~', '删除线');
      case 'inline-code': return wrap('`', '`', 'code');
      case 'mark': return colorDialog();
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return prefixLines('#'.repeat(Number(name.slice(1))) + ' ');
      case 'ul': return prefixLines('- ');
      case 'ol': return prefixLines('', true);
      case 'task': return prefixLines('- [ ] ');
      case 'quote': return prefixLines('> ');
      case 'link': return wrap('[', '](https://)', '链接文字');
      case 'image': return pickBodyImage();
      case 'table': return insertBlock(TABLE_TPL, true);
      case 'code': return codeDialog();
      case 'hr': return insertBlock('---');
      case 'more': return insertBlock('<!-- more -->');
      case 'footnote': return footnote();
      case 'kbd': return wrap('<kbd>', '</kbd>', 'Ctrl');
      case 'sup': return wrap('<sup>', '</sup>', '1');
      case 'sub': return wrap('<sub>', '</sub>', '2');
      case 'center': return wrap('<div align="center">\n\n', '\n\n</div>', '居中内容');
      case 'details': return wrap('<details>\n<summary>展开查看</summary>\n\n', '\n\n</details>', '折叠内容');
      case 'bilibili': return videoDialog();
      case 'undo': return jumpHistory(-1);
      case 'redo': return jumpHistory(1);
      default: return;
    }
  }

  function colorDialog() {
    var chosen = 'red';
    var wrapEl = el('div');
    var colors = ['red', 'orange', 'green', 'blue', 'purple', 'gray'];
    var row = el('div', { class: 'seg' });
    colors.forEach(function (c) {
      var b = el('button', {
        type: 'button', text: c,
        style: 'color:' + c,
        onclick: function () { chosen = c; Array.from(row.children).forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); }
      });
      if (c === chosen) b.classList.add('on');
      row.appendChild(b);
    });
    wrapEl.appendChild(row);
    wrapEl.appendChild(el('p', { class: 'tip', html: '生成：<code>&lt;font color="red"&gt;文字&lt;/font&gt;</code>（与现有文章的写法一致）' }));
    openModal({
      title: '文字颜色',
      body: wrapEl,
      actions: [
        { label: '取消', value: null },
        { label: '插入', primary: true, onClick: function () { wrap('<font color="' + chosen + '">', '</font>', '文字'); } }
      ]
    });
  }

  function codeDialog() {
    var wrapEl = el('label', { class: 'field' }, [
      el('span', { class: 'lbl', text: '语言（可留空）' }),
      el('input', { type: 'text', placeholder: 'js / html / bash / yaml …' })
    ]);
    var input = wrapEl.querySelector('input');
    openModal({
      title: '插入代码块',
      body: wrapEl,
      actions: [
        { label: '取消', value: null },
        { label: '插入', primary: true, onClick: function () {
          var lang = input.value.trim();
          var ta = form.body;
          var sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || 'code';
          insertBlock('```' + lang + '\n' + sel + '\n```');
        } }
      ]
    });
  }

  function footnote() {
    var info = selInfo() || { a: lastAbs, b: lastAbs };
    var v = bodyText();
    var sel = v.slice(info.a, info.b) || '脚注内容';
    var n = (v.match(/\[\^\d+\]/g) || []).length + 1;
    wrap('[^' + n + ']', '', '');
    insertBlock('[^' + n + ']: ' + sel);
  }

  /** 从本地选一张图 → 复制进 source/images → 插入 markdown */
  async function pickBodyImage() {
    var input = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    document.body.appendChild(input);
    input.onchange = async function () {
      var file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      var path = await importImage(file);
      if (!path) return;
      // 光标落到图片行之后 → 这一行立即变成渲染态，图片马上看得见
      insertBlock('![](' + path + ')', true);
    };
    input.click();
  }

  /** 哔哩哔哩 / YouTube 播放器块 */
  function videoDialog() {
    var box = el('div');
    var fields = {};
    function mkField(key, label, ph) {
      var f = el('label', { class: 'field' }, [
        el('span', { class: 'lbl', text: label }),
        el('input', { type: 'text', placeholder: ph || '' })
      ]);
      fields[key] = f.querySelector('input');
      box.appendChild(f);
    }
    mkField('bvid', '哔哩哔哩', 'BV1CibC6BEdT 或 https://www.bilibili.com/video/BV…/');
    mkField('youtube', 'YouTube', 'bI5YOkr5-Lc 或 https://youtu.be/…');

    // 判断网络自动选择开关（默认勾选）
    var autoChk = el('input', { type: 'checkbox' });
    autoChk.checked = true;
    box.appendChild(el('label', { class: 'chk' }, [
      autoChk,
      el('span', { text: '判断网络，自动选择哔哩哔哩 / YouTube' })
    ]));
    var autoHint = el('p', { class: 'tip' });
    box.appendChild(autoHint);
    function refreshAutoHint() {
      autoHint.innerHTML = autoChk.checked
        ? '勾选后：<b>哔哩哔哩和 YouTube 都要填</b>。发布后播放器会用 <code>checkGoogle()</code> 判断访客网络，' +
          '能访问 YouTube 就加载 YouTube，否则加载哔哩哔哩 —— 与站内 23 篇文章的写法一致。'
        : '未勾选：只需填 <b>其中一个</b>，播放器固定加载你填的那个平台，不判断网络。';
    }
    autoChk.addEventListener('change', refreshAutoHint);
    refreshAutoHint();

    var styleRow = el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: '样式' }),
      el('div', { class: 'seg' }, [
        el('button', { type: 'button', class: 'on', text: '等比 16:9（多数文章）', onclick: function (e) { pickStyle('padded', e.target); } }),
        el('button', { type: 'button', text: '固定高 450', onclick: function (e) { pickStyle('simple', e.target); } })
      ])
    ]);
    var style = 'padded';
    function pickStyle(v, btn) {
      style = v;
      Array.from(btn.parentNode.children).forEach(function (b) { b.classList.remove('on'); });
      btn.classList.add('on');
    }
    box.appendChild(styleRow);
    var quoteChk = el('input', { type: 'checkbox' });
    box.appendChild(el('label', { class: 'chk' }, [quoteChk, el('span', { text: '同时追加以 “> 视频” 开头的引用链接' })]));

    openModal({
      title: '插入视频播放器块',
      body: box,
      actions: [
        { label: '取消', value: null },
        { label: '插入', primary: true, onClick: function () {
          var bili = Core.normalizeBilibiliId(fields.bvid.value);
          var bvid = bili.bvid;
          var yt = Core.normalizeYoutubeId(fields.youtube.value);
          var auto = autoChk.checked;

          if (auto) {
            if (!bvid || !yt) {
              toast('自动选择模式：哔哩哔哩和 YouTube 都必须填写', 'err');
              return false;
            }
          } else if (!bvid && !yt) {
            toast('至少填一个平台（哔哩哔哩或 YouTube）', 'err');
            return false;
          }

          var block = Core.buildVideoBlock({
            bvid: bvid,
            youtube: yt,
            style: style,
            auto: auto,
            includeQuote: quoteChk.checked,
            bilibiliUrl: bvid ? 'https://www.bilibili.com/video/' + bvid + '/' : '',
            youtubeUrl: yt ? 'https://youtu.be/' + yt : ''
          });
          insertBlock(block);
        } }
      ]
    });
  }

  function updateStats() {
    var v = bodyText();
    if (!v) {
      $('#stat').textContent = '0 字符';
      return;
    }
    var cjk = (v.match(/[\u4e00-\u9fa5]/g) || []).length;
    var words = (v.match(/[A-Za-z0-9_]+/g) || []).length;
    var lines = v.split('\n').length;
    var minutes = Math.max(1, Math.round((cjk + words) / 400));
    $('#stat').textContent = v.length + ' 字符 · ' + lines + ' 行 · ' + (cjk + words) + ' 字 · 约 ' + minutes + ' 分钟';
  }

  function updateCursor() {
    var info = selInfo();
    var abs = info ? info.a : lastAbs;
    var upto = bodyText().slice(0, abs);
    var line = upto.split('\n').length;
    var col = upto.length - upto.lastIndexOf('\n');
    $('#cursor-info').textContent = '第 ' + line + ' 行，第 ' + col + ' 列';
  }

  /* ================================================================
   * 10. 正文输入
   * ================================================================ */
  var scheduleDraft = debounce(saveDraft, 800);
  var scheduleHistory = debounce(function () {
    if (!keepHistory) pushHistory();
  }, 450);

  function onBodyInput() {
    if (!state.current || suppress) return;
    // 兜底：某一行被塞进了换行（粘贴 / 输入法提交）→ 按行重排，光标跟着偏移走
    if (!composing && hasStrayNewline()) {
      var info0 = selInfo();
      renderBody(bodyText(), info0 ? info0.a : undefined);
    }
    refreshTypes();
    state.current.doc.body = bodyText();
    markDirty();
    updateStats();
    updateCursor();
    scheduleDraft();
    scheduleHistory();
  }

  /* ---------------- 正文编辑行为（回车 / 退格 / 粘贴 / 组字） ---------------- */
  function nextPrefix(cur) {
    var m;
    if ((m = /^(\s{0,3})([-*+])\s+\[[ xX]\]\s+/.exec(cur))) return m[1] + m[2] + ' [ ] ';
    if ((m = /^(\s{0,3})([-*+])\s+/.exec(cur))) return m[1] + m[2] + ' ';
    if ((m = /^(\s{0,3})(\d+)([.)])\s+/.exec(cur))) return m[1] + (Number(m[2]) + 1) + m[3] + ' ';
    if ((m = /^(\s{0,3})>\s?/.exec(cur))) return m[1] + '> ';
    return '';
  }

  function eolOf(text, from) {
    var i = text.indexOf('\n', from);
    return i === -1 ? text.length : i;
  }

  function insertNewline() {
    var info = selInfo();
    if (!info) return;
    var text = bodyText();
    var ls = text.lastIndexOf('\n', info.a - 1) + 1;
    var le = eolOf(text, info.a);
    var cur = text.slice(ls, le);
    var prefix = nextPrefix(cur);
    if (prefix && cur.trim() === prefix.trim()) {
      // 空的列表项：回车 = 退出列表（把这一行的标记去掉，光标留在行首）
      applyText(text.slice(0, ls) + text.slice(le), ls);
      return;
    }
    var payload = '\n' + prefix;
    applyText(text.slice(0, info.b) + payload + text.slice(info.b), info.b + payload.length);
  }

  function atLineStart() {
    var info = selInfo();
    if (!info || info.a !== info.b) return false;
    var text = bodyText();
    return text.lastIndexOf('\n', info.a - 1) === info.a - 1;
  }

  function atLineEnd() {
    var info = selInfo();
    if (!info || info.a !== info.b) return false;
    var text = bodyText();
    return info.a === text.length || text.charAt(info.a) === '\n';
  }

  function mergeUp() {
    var info = selInfo();
    if (!info) return;
    var text = bodyText();
    var ls = text.lastIndexOf('\n', info.a - 1) + 1;
    if (ls === 0) return;
    var prevEnd = ls - 1;
    applyText(text.slice(0, prevEnd) + text.slice(ls), prevEnd);
  }

  function mergeDown() {
    var info = selInfo();
    if (!info) return;
    var text = bodyText();
    var le = eolOf(text, info.a);
    if (le === text.length) return;
    applyText(text.slice(0, le) + text.slice(le + 1), le);
  }

  function onBodyKeydown(e) {
    if (e.isComposing || composing) return;
    var mod = e.ctrlKey || e.metaKey;
    var k = (e.key || '').toLowerCase();
    if (mod && !e.shiftKey && k === 'z') { e.preventDefault(); jumpHistory(-1); return; }
    if (mod && (k === 'y' || (e.shiftKey && k === 'z'))) { e.preventDefault(); jumpHistory(1); return; }
    if (mod) return;
    if (e.key === 'Enter') { e.preventDefault(); insertNewline(); return; }
    if (e.key === 'Tab') { e.preventDefault(); insertText('  '); return; }
    if (e.key === 'Backspace' && atLineStart()) { e.preventDefault(); mergeUp(); return; }
    if (e.key === 'Delete' && atLineEnd()) { e.preventDefault(); mergeDown(); return; }
  }

  function onBodyPaste(e) {
    if (!e.clipboardData) return;
    e.preventDefault();
    var t = e.clipboardData.getData('text/plain');
    if (t) insertText(String(t).replace(/\r\n?/g, '\n'));
  }

  /**
   * 点表格单元格 / 整行图片时，把光标放到对应的源码位置。
   * 这两类都是「渲染态只是一层皮」，直接让浏览器放光标会飘到行首，
   * 所以自己算绝对偏移：点第几个单元格就落在第几个单元格的文字上。
   */
  function onBodyMouseDown(e) {
    if (!bodyEl || !state.current) return;
    var t = e.target;
    if (!t || !t.closest) return;
    var cell = t.closest('.tc');
    var img = t.closest('img.ed-img');
    if (!cell && !img) return;
    e.preventDefault();
    var line = (cell || img).parentElement;
    var lines = lineEls();
    var idx = lines.indexOf(line);
    if (idx < 0) return;
    var base = 0;
    for (var i = 0; i < idx; i++) base += textOf(lines[i]).length + 1;
    var at = cell ? (Number(cell.getAttribute('data-at')) || 0) : textOf(line).length;
    setCaret(base + at);
    syncActiveLine();
    updateCursor();
  }

  function onSelChange() {
    if (suppress || !bodyEl || !state.current) return;
    var s = window.getSelection();
    if (!s || !s.rangeCount) return;
    if (!bodyEl.contains(s.anchorNode)) return;
    syncActiveLine();
    updateCursor();
  }

  /* ================================================================
   * 11. 草稿（localStorage）
   * ================================================================ */
  function draftKey(p) { return 'hexo-editor:draft:' + p.path; }

  function saveDraft() {
    var p = state.current;
    if (!p || !p.dirty) return;
    try {
      localStorage.setItem(draftKey(p), JSON.stringify({
        at: Date.now(),
        text: Core.stringifyPost(p.doc)
      }));
    } catch (e) { /* 忽略配额错误 */ }
  }

  function clearDraft(p) {
    try { localStorage.removeItem(draftKey(p)); } catch (e) {}
  }

  function commitCurrentDraft() {
    if (state.current && state.current.dirty) saveDraft();
  }

  async function checkDraft(p) {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(draftKey(p)) || 'null'); } catch (e) {}
    if (!saved || !saved.text) return;
    if (saved.text === p.raw) { clearDraft(p); return; }
    var choice = await openModal({
      title: '发现未保存的草稿',
      body: '<p class="tip">这篇文章有一份本地草稿（' + new Date(saved.at).toLocaleString() +
        '），比磁盘上的文件更新。要恢复吗？</p><p class="tip">草稿内容：<br><code>' +
        escapeHtml(saved.text.slice(0, 260)) + (saved.text.length > 260 ? '…' : '') + '</code></p>',
      actions: [
        { label: '用磁盘上的版本', value: 'discard' },
        { label: '恢复草稿', primary: true, value: 'restore' }
      ]
    });
    if (choice === 'restore') {
      p.doc = Core.parsePost(saved.text, { isNew: p.isNew });
      p.raw = saved.text;
      p.savedOnce = true;
      var keepDirty = true;
      openPost(p, { keepDirty: keepDirty });
      toast('已恢复草稿，记得保存', 'ok');
    } else {
      clearDraft(p);
    }
  }

  /* ================================================================
   * 12. 保存 / 新建 / 删除
   * ================================================================ */
  function currentText() {
    return Core.stringifyPost(state.current.doc);
  }

  async function savePost(opts) {
    opts = opts || {};
    var p = state.current;
    if (!p) return;
    var issues = validateAndShow();
    var errors = (issues || []).filter(function (i) { return i.level === 'error'; });
    if (errors.length && !opts.force) {
      toast('请先修正：' + errors.map(function (e) { return e.message; }).join('；'), 'err');
      return;
    }

    var name = form.fileName.value.trim();
    if (!name) name = Core.suggestFilename(String(Core.get(p.doc, 'title') || ''), Core.get(p.doc, 'date'), 'yy');
    if (!/\.md$/i.test(name)) name += '.md';
    name = name.replace(/[\\/:*?"<>|]/g, '').trim();
    if (!name || name === '.md') { toast('文件名不合法', 'err'); return; }

    var text = currentText();
    // p.name 始终是「磁盘上真实存在的文件名」，与输入框分开管理
    var oldName = p.name;

    if (state.mode !== 'fs') {
      // 导入模式：下载文件
      downloadBlob(text, name);
      p.name = name;
      p.path = name;
      p.raw = text;
      p.savedOnce = true;
      p.dirty = false;
      form.fileName.value = name;
      clearDraft(p);
      applyLocks();
      updateDirtyUI();
      renderList();
      toast('已下载 ' + name + '，请放回 source/_posts', 'ok');
      return;
    }

    try {
      var renamed = name !== oldName;
      await FS.write(state.postsDir, name, text);
      if (renamed && !p.isNew) {
        var ok = await openModal({
          title: '文件名已修改',
          body: '<p class="tip">已写入 <code>' + escapeHtml(name) + '</code>。<br>要删除旧文件 <code>' +
            escapeHtml(oldName) + '</code> 吗？（不删除会出现两篇重复文章）</p>',
          actions: [{ label: '保留旧文件', value: false }, { label: '删除旧文件', primary: true, value: true, danger: true }]
        });
        if (ok) {
          try { await FS.remove(oldName); } catch (e) { toast('删除旧文件失败：' + e.message, 'err'); }
        }
      }
      p.name = name;
      p.path = name;
      p.raw = text;
      p.isNew = false;
      p.savedOnce = true;
      p.dirty = false;
      clearDraft(p);
      await FS.loadAll();
      var again = state.posts.find(function (x) { return x.name === name; });
      if (again) openPost(again, { skipDraftCheck: true });
      else { updateDirtyUI(); applyLocks(); renderFrontMatter(); renderList(); }
      toast('已保存 ' + name, 'ok');
    } catch (e) {
      console.error(e);
      toast('保存失败：' + e.message, 'err');
    }
  }

  async function newPost() {
    commitCurrentDraft();
    var title = await promptText('新建文章', '标题 title', '', '文章标题');
    if (title == null) return;

    var now = new Date();
    var doc = Core.createPost({
      title: title,
      description: '',
      tags: [],
      cover: ''
    });
    Core.set(doc, 'date', Core.formatDateTime(now));

    var name = Core.suggestFilename(title, now, 'yy');
    var p = {
      id: uid(),
      path: name,
      name: name,
      doc: doc,
      raw: '',
      handle: null,
      dirty: true,
      savedOnce: false,
      isNew: true
    };
    state.posts.unshift(p);
    openPost(p);
    form.fileName.select();
    toast('日期与 abbrlink 已锁定：保存后日期解锁，hexo generate 后 abbrlink 解锁');
  }

  async function duplicatePost() {
    var p = state.current;
    if (!p) return;
    var text = currentText();
    var name = p.name.replace(/\.md$/i, '') + ' 副本.md';
    var doc = Core.parsePost(text, { isNew: true });
    var copy = {
      id: uid(), path: name, name: name, doc: doc, raw: '',
      handle: null, dirty: true, savedOnce: false, isNew: true
    };
    state.posts.unshift(copy);
    openPost(copy);
    toast('已复制为新文章，保存后才会写入磁盘');
  }

  async function deletePost() {
    var p = state.current;
    if (!p) return;
    var ok = await openModal({
      title: '删除文章',
      body: '<p class="tip">确定删除 <code>' + escapeHtml(p.name) + '</code> 吗？' +
        (state.mode === 'fs' ? '文件会从磁盘移除。' : '仅从当前列表移除。') + '</p>',
      actions: [{ label: '取消', value: false }, { label: '删除', primary: true, danger: true, value: true }]
    });
    if (!ok) return;
    try {
      if (state.mode === 'fs' && !p.isNew) await FS.remove(p.name);
      state.posts = state.posts.filter(function (x) { return x.id !== p.id; });
      clearDraft(p);
      closeEditor();
      reindex();
      toast('已删除');
    } catch (e) {
      toast('删除失败：' + e.message, 'err');
    }
  }

  /* ================================================================
   * 13. 导入模式（无 File System Access API）
   * ================================================================ */
  function importFolder() {
    var input = el('input', { type: 'file', multiple: true, webkitdirectory: '', directory: '', style: 'display:none' });
    document.body.appendChild(input);
    input.onchange = async function () {
      var files = Array.prototype.slice.call(input.files || []);
      input.remove();
      if (!files.length) return;
      var posts = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (!/\.md$/i.test(f.name)) continue;
        var raw = await f.text();
        var doc = Core.parsePost(raw);
        posts.push({
          id: uid(), path: f.webkitRelativePath || f.name, name: f.name,
          handle: null, doc: doc, raw: raw, dirty: false, savedOnce: true
        });
      }
      if (!posts.length) { toast('这个文件夹里没有 .md 文件', 'err'); return; }
      state.mode = 'files';
      state.posts = posts;
      state.current = null;
      reindex();
      updateModeUI();
      toast('已导入 ' + posts.length + ' 篇（保存会下载文件，请手动放回 _posts）', 'ok');
    };
    input.click();
  }

  function updateModeUI() {
    var hint = $('#api-hint');

    if (!hasFSA) {
      hint.className = 'hint warn';
      hint.innerHTML = '当前浏览器没有提供 <b>File System Access API</b>，无法直接读写本地文件。' +
        '可以先用「导入文件夹」只读编辑、保存时下载文件；<br>' +
        '要直接写回 <code>source/_posts</code>，请改用 <b>Chrome / Edge</b> 打开本页（双击 <code>index.html</code> 即可）。';
    } else {
      hint.className = 'hint';
      hint.textContent = '';
    }

    renderDirDots();
    refreshMainView();
  }

  /** 主区三种状态：未连目录→欢迎页；连了但没选文章→灰掉的编辑器；选了→正常编辑 */
  function refreshMainView() {
    var connected = state.mode === 'fs' || state.mode === 'files';
    var idle = connected && !state.current;

    $('#empty').classList.toggle('hidden', connected);
    $('#editor').classList.toggle('hidden', !connected);
    $('#editor').classList.toggle('idle', idle);
    $('#idle-hint').classList.toggle('hidden', !idle);

    var body = $('#editor').querySelector('.ed-body');
    if (body && 'inert' in body) body.inert = idle;

    // 空闲态：清空上次残留，文件名框禁用
    var fn = $('#file-name');
    if (fn) fn.disabled = idle;
    if (idle && form && form.title) {
      ['fileName', 'title', 'abbrlink', 'description', 'date', 'cover', 'body'].forEach(function (k) {
        if (form[k]) form[k].value = '';
      });
      if (form.tagsChips) form.tagsChips.innerHTML = '';
      if (form.tagsInput) form.tagsInput.value = '';
      updateCoverPreview();
    }

    // 只有打开文章后才出现「收起/展开列表」按钮；没有打开文章时列表一定展开
    $('#btn-toggle-sidebar').classList.toggle('hidden', !state.current);
    if (!state.current) state.sidebarCollapsed = false;
    applySidebar();
  }

  function applySidebar() {
    var app = $('#app');
    if (app) app.classList.toggle('collapsed', !!state.sidebarCollapsed && !!state.current);
  }

  function toggleSidebar() {
    if (!state.current) return;      // 没选文章时不允许收起
    state.sidebarCollapsed = !state.sidebarCollapsed;
    applySidebar();
  }

  /** 列表底部的两个状态圆点：绿=已连接，红=未连接 */
  function renderDirDots() {
    var p = $('#dot-posts');
    var im = $('#dot-images');
    if (!p || !im) return;

    var postsOk = state.mode === 'fs' && !!state.postsDir;
    p.classList.toggle('on', postsOk);
    p.title = postsOk
      ? '文章目录已连接：' + (state.dirName || state.postsDir.name) + '（点击更换）'
      : (state.rootRemembered
        ? '上次的文章目录 ' + state.rootRemembered.name + ' 需要重新授权（点击处理）'
        : '文章目录未连接（点击连接）');

    var imgOk = !!state.hasImages;
    im.classList.toggle('on', imgOk);
    im.title = imgOk
      ? '图片目录已连接：' + (state.imagesDir ? state.imagesDir.name : '') + '（点击更换）'
      : (state.imagesRemembered
        ? '上次的图片目录 ' + state.imagesRemembered.name + ' 需要重新授权（点击处理）'
        : '图片目录未连接（点击连接）');
  }

  /** 两个目录是不是都连好了（文章目录能用 + 图片目录连上） */
  function dirsReady() {
    var postsOk = state.mode === 'fs' && !!state.postsDir;
    return postsOk && !!state.hasImages;
  }

  /** 需要时才弹引导：第一次打开、或任一目录没连上 */
  function maybeOpenDirGuide() {
    if (dirsReady()) return false;
    openDirGuide();
    return true;
  }

  /**
   * 连接目录引导：打开编辑器时自动弹一次，点左下角圆点也能随时回来改。
   * 直接用 openModal 的 body 容器，选完目录原地刷新，不关窗。
   */
  function openDirGuide() {
    var box = el('div', { class: 'guide' });

    function rowOf(kind) {
      var isPosts = kind === 'posts';
      var ok = isPosts ? (state.mode === 'fs' && !!state.postsDir) : !!state.hasImages;
      var remembered = isPosts ? state.rootRemembered : state.imagesRemembered;
      var name = isPosts
        ? (state.dirName || (state.postsDir ? state.postsDir.name : ''))
        : (state.imagesDir ? state.imagesDir.name : (remembered ? remembered.name : ''));

      var sub;
      if (ok) {
        sub = '已连接' + (name ? '：' + name : '') + (isPosts ? ' · ' + state.posts.length + ' 篇文章' : '');
      } else if (remembered) {
        sub = '已记住 ' + remembered.name + '，但浏览器重启后要补一次授权';
      } else {
        sub = isPosts
          ? '必填。选项目根目录最省事，会自动识别 source/_posts'
          : '可选。不连也能写文章，只是封面和正文图片存不进来';
      }

      var btns = el('div', { class: 'guide-btns' });
      if (remembered && !ok) {
        btns.appendChild(el('button', {
          class: 'btn tiny', type: 'button', text: '重新授权',
          onclick: function () { grant(kind); }
        }));
      }
      btns.appendChild(el('button', {
        class: 'btn tiny' + (ok ? '' : ' primary'), type: 'button',
        text: ok ? '更换' : '选择目录',
        onclick: function () { pick(kind); }
      }));

      return el('div', { class: 'guide-row' + (ok ? ' on' : '') }, [
        el('i', { class: 'g-dot' }),
        el('div', { class: 'guide-txt' }, [
          el('div', { class: 'guide-name', text: isPosts ? '文章目录' : '图片目录' }),
          el('div', { class: 'guide-sub', text: sub })
        ]),
        btns
      ]);
    }

    function render() {
      box.innerHTML = '';
      box.appendChild(el('p', {
        class: 'tip',
        html: '选一次就好，浏览器会记住这两个目录，下次打开自动恢复。' +
          '<br>想换目录，点左下角的两个圆点随时回来。'
      }));
      box.appendChild(rowOf('posts'));
      box.appendChild(rowOf('images'));
      renderDirDots();
    }

    async function pick(kind) {
      if (!hasFSA) { toast('这个浏览器用不了目录选择，请换 Chrome / Edge 打开', 'err'); return; }
      try {
        if (kind === 'posts') {
          var gotPosts = await FS.pick();
          if (gotPosts) {
            state.rootRemembered = null;
            toast('文章目录已连接：' + state.dirName, 'ok');
          }
        } else {
          var gotImages = await FS.pickImages();
          if (gotImages) {
            state.imagesRemembered = null;
            toast('图片目录已连接', 'ok');
          }
        }
      } catch (e) {
        console.error(e);
        toast((kind === 'posts' ? '打开文章目录失败：' : '连接图片目录失败：') + e.message, 'err');
      }
      updateModeUI();
      render();
    }

    async function grant(kind) {
      var h = kind === 'posts' ? state.rootRemembered : state.imagesRemembered;
      if (!h) return;
      try {
        var perm = await h.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') { toast('没有拿到写入权限', 'err'); render(); return; }
        if (kind === 'posts') {
          state.rootRemembered = null;
          await FS.attach(h);
        } else {
          state.imagesRemembered = null;
          state.imagesDir = h;
          state.hasImages = true;
        }
        toast('已重新授权', 'ok');
      } catch (e) {
        console.error(e);
        toast('授权失败：' + e.message, 'err');
      }
      updateModeUI();
      render();
    }

    render();

    var actions = [];
    if (!hasFSA) actions.push({ label: '导入文件夹', value: 'import' });
    actions.push({ label: '进入编辑器', primary: true, value: true });

    return openModal({
      title: '连接目录',
      body: box,
      enterConfirm: false,
      actions: actions
    }).then(function (v) {
      if (v === 'import') importFolder();
      return v;
    });
  }

  /* ================================================================
   * 13.5 主题：白天 / 黑夜 / 自动（跟随系统）
   * ================================================================ */
  var THEME_KEY = 'hexo-editor:theme';

  function themeMode() {
    var m = 'auto';
    try { m = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { /* file:// 下可能被禁 */ }
    return ['light', 'dark', 'auto'].indexOf(m) === -1 ? 'auto' : m;
  }

  function systemDark() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) { return false; }
  }

  /** 把当前模式落到 html[data-theme] 上，并点亮对应的那个按钮 */
  function applyTheme() {
    var mode = themeMode();
    var effective = mode === 'auto' ? (systemDark() ? 'dark' : 'light') : mode;
    document.documentElement.setAttribute('data-theme', effective);
    $$('#theme-switch button').forEach(function (b) {
      var on = b.getAttribute('data-theme') === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    return effective;
  }

  function setTheme(mode) {
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* 忽略 */ }
    return applyTheme();
  }

  /** 连接图片目录的统一入口（按钮 / 状态栏链接都走这里） */
  async function pickImagesFlow() {
    if (!hasFSA) {
      toast('这个浏览器用不了目录选择，请换 Chrome / Edge 打开', 'err');
      return;
    }
    try {
      var ok = await FS.pickImages();
      if (ok) toast('图片目录已连接，封面与正文图片可以预览了', 'ok');
    } catch (e) {
      console.error(e);
      toast('连接图片目录失败：' + e.message, 'err');
    }
  }

  /* ================================================================
   * 14. 绑定事件
   * ================================================================ */
  function bind() {
    cacheForm();

    /* --- 目录连接：只剩底部两个圆点（顶部按钮已移除，弹窗由引导负责） --- */
    $('#dot-posts').onclick = function () { openDirGuide(); };
    $('#dot-images').onclick = function () { openDirGuide(); };

    /* --- 侧栏收起 / 展开 --- */
    $('#btn-toggle-sidebar').onclick = toggleSidebar;

    /* --- 主题：太阳 / 月亮 / 自动 --- */
    $$('#theme-switch button').forEach(function (b) {
      b.onclick = function () { setTheme(b.getAttribute('data-theme')); };
    });
    if (window.matchMedia) {
      try {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        var onSystem = function () { if (themeMode() === 'auto') applyTheme(); };
        if (mq.addEventListener) mq.addEventListener('change', onSystem);
        else if (mq.addListener) mq.addListener(onSystem);
      } catch (e) { /* 忽略 */ }
    }

    /* --- 新建 / 刷新 --- */
    $('#btn-new').onclick = newPost;
    $('#btn-refresh').onclick = async function () {
      commitCurrentDraft();
      if (state.mode === 'fs') {
        try {
          await FS.reload();
          updateModeUI();
        } catch (e) { toast('刷新失败：' + e.message, 'err'); }
      } else {
        importFolder();
      }
    };

    /* --- 筛选 --- */
    $('#search').oninput = debounce(function (e) {
      state.filter.q = e.target.value.trim();
      renderList();
    }, 120);
    $('#sort').onchange = function (e) { state.filter.sort = e.target.value; renderList(); };
    $('#filter-dirty').onchange = function (e) { state.filter.dirtyOnly = e.target.checked; renderList(); };

    /* --- 属性字段 --- */
    form.title.oninput = function () {
      setField('title', form.title.value);
      renderFrontMatter();
    };
    form.description.oninput = function () { setField('description', form.description.value); };
    form.cover.oninput = function () {
      setField('cover', form.cover.value.trim());
      updateCoverPreview();
    };
    form.abbrlink.oninput = function () { setField('abbrlink', form.abbrlink.value.trim()); };
    form.date.oninput = function () {
      var v = form.date.value.trim();
      if (v && !Core.parseDate(v)) { form.date.classList.add('invalid'); }
      else { form.date.classList.remove('invalid'); setField('date', v); }
    };
    form.date.onblur = function () {
      var v = form.date.value.trim();
      var d = Core.parseDate(v);
      if (d) {
        var normalized = Core.hasTimePart(v) ? Core.formatDateTime(d) : Core.formatDate(d);
        form.date.value = normalized;
        setField('date', normalized);
      }
      form.date.classList.remove('invalid');
    };

    /* --- 标签输入 --- */
    form.tagsInput.onkeydown = function (e) {
      if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
        e.preventDefault();
        addTag(form.tagsInput.value);
      } else if (e.key === 'Backspace' && form.tagsInput.value === '') {
        var arr = Core.get(state.current.doc, 'tags') || [];
        if (arr.length) {
          arr = arr.slice(0, -1);
          setField('tags', arr);
          renderChips();
        }
      }
    };
    form.tagsInput.oninput = renderSuggest;
    form.tagsInput.onblur = function () {
      if (form.tagsInput.value.trim()) addTag(form.tagsInput.value);
    };

    /* --- 锁定开关 --- */
    $('#lock-abbrlink').onclick = function (e) {
      e.preventDefault();
      var p = state.current;
      if (!p) return;
      if (String(Core.get(p.doc, 'abbrlink') || '').trim()) {
        toast('abbrlink 已存在，可直接编辑');
        return;
      }
      p.forceAbbrlink = !p.forceAbbrlink;
      applyLocks();
      if (p.forceAbbrlink) toast('已临时解锁 abbrlink（一般不需要手动填）');
    };
    $('#lock-date').onclick = function (e) {
      e.preventDefault();
      var p = state.current;
      if (!p) return;
      if (p.savedOnce) { toast('日期可直接编辑'); return; }
      toast('先保存文章，日期才会解锁', 'err');
    };

    /* --- 封面 --- */
    $('#btn-cover-pick').onclick = function () {
      var input = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
      document.body.appendChild(input);
      input.onchange = async function () {
        var file = input.files && input.files[0];
        input.remove();
        if (!file) return;
        var path = await importImage(file);
        if (!path) return;
        form.cover.value = path;
        setField('cover', path);
        updateCoverPreview();
      };
      input.click();
    };
    $('#btn-cover-clear').onclick = function () {
      form.cover.value = '';
      setField('cover', '');
      updateCoverPreview();
    };
    $('#cover-preview').addEventListener('dragover', function (e) { e.preventDefault(); });
    $('#cover-preview').addEventListener('drop', async function (e) {
      e.preventDefault();
      var file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      var path = await importImage(file);
      if (!path) return;
      form.cover.value = path;
      setField('cover', path);
      updateCoverPreview();
    });

    /* --- 预估 abbrlink --- */
    $('#btn-predict-link').onclick = function () {
      var t = String(Core.get(state.current.doc, 'title') || '');
      var guess = Core.predictAbbrlink(t);
      openModal({
        title: '预估 abbrlink',
        body: '<p class="tip">按 <code>_config.yml</code> 里的 <code>abbrlink.alg: crc32</code> + <code>rep: hex</code>，' +
          'crc32(标题) = <code>' + guess + '</code>。</p>' +
          '<p class="tip">注意：Hexo 只在文章<b>还没有</b> abbrlink 时写入一次，之后改标题也不会重算 —— ' +
          '所以这里只是预估，实际以 <code>hexo generate</code> 写入的为准。</p>',
        actions: [
          { label: '关闭', value: null },
          { label: '填入', primary: true, onClick: function () {
            form.abbrlink.value = guess;
            setField('abbrlink', guess);
            state.current.forceAbbrlink = true;
            applyLocks();
          } }
        ]
      });
    };

    /* --- 属性区折叠 / front matter --- */
    $('#btn-props-toggle').onclick = function () {
      var body = $('.ed-body');
      body.classList.toggle('no-props');
      this.textContent = body.classList.contains('no-props') ? '展开' : '收起';
    };
    $('#btn-frontmatter').onclick = function () {
      var v = $('#frontmatter-view');
      v.classList.toggle('hidden');
      renderFrontMatter();
    };

    /* --- 保存 / 另存 / 复制 / 删除 --- */
    $('#btn-save').onclick = function () { savePost(); };
    $('#btn-saveas').onclick = async function () {
      var p = state.current;
      if (!p) return;
      var name = await promptText('另存为', '文件名', p.name.replace(/\.md$/i, ' 副本.md'));
      if (!name) return;
      var text = currentText();
      if (state.mode === 'fs') {
        try {
          await FS.write(state.postsDir, name, text);
          await FS.loadAll();
          var again = state.posts.find(function (x) { return x.name === name; });
          if (again) openPost(again);
          toast('已另存为 ' + name, 'ok');
        } catch (e) { toast('另存失败：' + e.message, 'err'); }
      } else {
        downloadBlob(text, name);
        toast('已下载 ' + name, 'ok');
      }
    };
    $('#btn-dup').onclick = duplicatePost;
    $('#btn-delete').onclick = deletePost;

    /* --- 正文（contenteditable：自己接管输入行为） --- */
    form.body.addEventListener('input', onBodyInput);
    form.body.addEventListener('keydown', onBodyKeydown);
    form.body.addEventListener('paste', onBodyPaste);
    form.body.addEventListener('mousedown', onBodyMouseDown);
    form.body.addEventListener('compositionstart', function () { composing = true; });
    form.body.addEventListener('compositionend', function () {
      composing = false;
      refreshTypes();
      onBodyInput();
    });
    document.addEventListener('selectionchange', onSelChange);

    /* --- 工具栏（mousedown 阻止默认，避免正文选区丢失） --- */
    $('#toolbar').addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) e.preventDefault();
    });
    $('#toolbar').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      action(btn.getAttribute('data-act'));
    });

    /* --- 文件名 --- */
    // 只标记「待改名」，不直接改 p.name —— p.name 始终代表磁盘上真实的文件名
    form.fileName.onchange = function () {
      if (!state.current) return;
      var v = form.fileName.value.trim();
      if (v === state.current.name) return;
      markDirty();
    };

    /* --- 拖放图片 --- */
    var dropHint = $('#drop-hint');
    var dragDepth = 0;
    document.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') === -1) return;
      dragDepth += 1;
      dropHint.classList.add('on');
    });
    document.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropHint.classList.remove('on');
    });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', async function (e) {
      e.preventDefault();
      dragDepth = 0;
      dropHint.classList.remove('on');
      if (!state.current) return;
      var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
      var images = files.filter(function (f) { return /^image\//.test(f.type); });
      if (!images.length) return;
      for (var i = 0; i < images.length; i++) {
        var path = await importImage(images[i]);
        if (path) insertBlock('![](' + path + ')', true);
      }
    });

    /* --- 快捷键 --- */
    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      var k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); savePost(); }
      else if (k === 'b') { e.preventDefault(); action('bold'); }
      else if (k === 'i') { e.preventDefault(); action('italic'); }
      else if (k === 'k') { e.preventDefault(); action('link'); }
      else if (k === '2') { e.preventDefault(); action('h2'); }
      else if (k === '3') { e.preventDefault(); action('h3'); }
      else if (k === '4') { e.preventDefault(); action('h4'); }
      else if (k === 'n' && e.shiftKey) { e.preventDefault(); newPost(); }
    });

    window.addEventListener('beforeunload', function (e) {
      var dirty = state.posts.some(function (p) { return p.dirty; });
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  /* ================================================================
   * 15. 启动
   * ================================================================ */
  async function boot() {
    bind();
    applyTheme();
    updateModeUI();

    var restored = false;

    if (hasFSA) {
      // 1) 先恢复上次单独连接的图片目录（不依赖文章目录）
      var imgHandle = await idb.get('images');
      if (imgHandle) {
        try {
          var ip = await imgHandle.queryPermission({ mode: 'readwrite' });
          if (ip === 'granted') {
            state.imagesDir = imgHandle;
            state.hasImages = true;
          } else {
            state.imagesRemembered = imgHandle; // 记住了，但这次要补一次授权
          }
        } catch (e) { /* 忽略 */ }
      }

      // 2) 再恢复文章目录
      var handle = await idb.get('root');
      if (handle) {
        try {
          var perm = await handle.queryPermission({ mode: 'readwrite' });
          if (perm === 'granted') {
            // 只恢复目录与列表，不自动打开文章：右侧保持灰色空态
            if (await FS.attach(handle)) restored = true;
          } else {
            state.rootRemembered = handle;
          }
        } catch (e) {
          console.warn('恢复目录失败', e);
        }
      }
    }

    updateModeUI();
    if (restored) toast('已从浏览器缓存恢复上次的目录', 'ok');

    // 两个目录都连好就静默进入；第一次打开、或有目录没连上才弹引导
    maybeOpenDirGuide();
  }

  document.addEventListener('DOMContentLoaded', function () {
    cacheForm();
    boot();
  });

  /* ================================================================
   * 16. 对外暴露（供测试与命令行调试使用）
   * ================================================================ */
  window.HexoEditor = {
    state: state,
    form: form,
    fs: FS,
    openPost: openPost,
    closeEditor: closeEditor,
    newPost: newPost,
    savePost: savePost,
    deletePost: deletePost,
    duplicatePost: duplicatePost,
    setField: setField,
    addTag: addTag,
    renderChips: renderChips,
    renderList: renderList,
    reindex: reindex,
    applyLocks: applyLocks,
    validateAndShow: validateAndShow,
    renderFrontMatter: renderFrontMatter,
    action: action,
    insertBlock: insertBlock,
    wrap: wrap,
    prefixLines: prefixLines,
    currentText: currentText,
    /* 正文（contenteditable）相关的测试钩子 */
    getBody: bodyText,
    setBody: function (text) {
      renderBody(text, 0);
      onBodyInput();
    },
    setSel: function (a, b) { bodyEl.focus(); setCaret(a, b); syncActiveLine(); updateCursor(); },
    selectAll: function () { bodyEl.focus(); setCaret(0, bodyText().length); syncActiveLine(); },
    getSel: function () { var i = selInfo(); return i || { a: lastAbs, b: lastAbs }; },
    lineTypes: function () { return lineEls().map(function (l) { return l.getAttribute('data-t'); }); },
    undo: function () { jumpHistory(-1); },
    redo: function () { jumpHistory(1); },
    historyPush: pushHistory,
    updateModeUI: updateModeUI,
    renderDirDots: renderDirDots,
    openDirGuide: openDirGuide,
    dirsReady: dirsReady,
    maybeOpenDirGuide: maybeOpenDirGuide,
    refreshMainView: refreshMainView,
    toggleSidebar: toggleSidebar,
    applyTheme: applyTheme,
    setTheme: setTheme,
    themeMode: themeMode,
    importFolder: importFolder,
    setMode: function (mode, list) {
      state.mode = mode;
      state.posts = list || [];
      state.current = null;
      reindex();
      updateModeUI();
    },
    /** 测试用：直接从内存里的 md 文本造一篇（不碰磁盘） */
    loadFromText: function (name, raw, opts) {
      opts = opts || {};
      var doc = Core.parsePost(raw, { isNew: !!opts.isNew });
      var p = {
        id: uid(), path: name, name: name, doc: doc, raw: raw, handle: null,
        dirty: !!opts.dirty, savedOnce: !opts.isNew, isNew: !!opts.isNew
      };
      state.posts.unshift(p);
      reindex();
      openPost(p, { skipDraftCheck: true });
      return p;
    }
  };
})();

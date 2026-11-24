import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { waitForBoot } from './helpers.mjs';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const yaml = require('js-yaml');
const vm = require('node:vm');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = require(root + '/assets/core.js');
let checks = 0;
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const raw = (title='A', body='disk body', abbr='abcdef12') => `---\ntitle: ${title}\nabbrlink: ${abbr}\ndescription: description\ntags: [test]\ndate: 2026-11-21 10:00:00\ncover: \n---\n${body}`;
function result(id, name, expected, actual, ok) {
  const item = {id, name, expected, actual, pass: ok};
  checks++; results.push(item); if (!ok) console.log(JSON.stringify(item));
}
class FileHandle {
  constructor(name, dir) { this.kind='file'; this.name=name; this.dir=dir; }
  async getFile() {
    if (!this.dir.files.has(this.name)) throw new Error('NotFoundError');
    const text=this.dir.files.get(this.name);
    return {text:async()=>text,lastModified:1700000000000};
  }
  async createWritable() {
    this.dir.writes = (this.dir.writes || 0) + 1;
    if (this.dir.delay) await sleep(this.dir.delay);
    if(this.dir.failWrite) throw new Error('Permission denied (injected)');
    let pending=''; const self=this;
    return {async write(text){pending=text;}, async close(){self.dir.files.set(self.name,pending);}};
  }
}
class Dir {
  constructor(name) {this.kind='directory';this.name=name;this.files=new Map();this.dirs=new Map();}
  async queryPermission(){return 'granted';}
  async requestPermission(){return 'granted';}
  async *values(){ for (const d of this.dirs.values()) yield d; for(const n of this.files.keys())yield new FileHandle(n,this); }
  async getDirectoryHandle(n,o){ if(!this.dirs.has(n)){if(!o?.create)throw new Error('NotFoundError');this.dirs.set(n,new Dir(n));} return this.dirs.get(n);}
  async getFileHandle(n,o){if(/[\\/]/.test(n)||n==='.'||n==='..')throw new TypeError('Invalid filename');if(!this.files.has(n)){if(!o?.create)throw new Error('NotFoundError');this.files.set(n,'');}return new FileHandle(n,this);}
  async removeEntry(n){if(!this.files.delete(n)&&!this.dirs.delete(n))throw new Error('NotFoundError');}
}
async function session() {
  const dom=new JSDOM(fs.readFileSync(root+'/index.html','utf8').replace(/<script src="assets\/[^\"]+"><\/script>/g,''),{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;w.indexedDB=undefined;w.URL.createObjectURL=()=> 'blob:mock';w.URL.revokeObjectURL=()=>{};
  for(const f of ['core.js','app.js'])w.eval(fs.readFileSync(root+'/assets/'+f,'utf8'));
  await waitForBoot(dom); const d=w.document,E=w.HexoEditor;
  d.querySelector('#modal-close').click();
  const project=new Dir('project'),source=new Dir('source'),posts=new Dir('_posts'),images=new Dir('images');
  project.dirs.set('source',source);source.dirs.set('_posts',posts);source.dirs.set('images',images);
  posts.files.set('a.md',raw('A'));posts.files.set('b.md',raw('B','B disk','bbbbbbbb'));
  await E.fs.attach(project);
  E.openPost(E.state.posts.find(p=>p.path==='a.md'),{skipDraftCheck:true});
  return {dom,w,d,E,project,source,posts,images};
}
async function finish(s){await sleep(50);s.dom.window.close();}
function modalButton(d,text){ const b=[...d.querySelectorAll('#modal-foot button')].find(b=>b.textContent===text);if(!b)throw new Error('Missing modal button '+text);b.click(); }
function input(s,id,value){const n=s.d.querySelector(id);n.value=value;n.dispatchEvent(new s.w.Event('input',{bubbles:true}));}
async function main(){
  {const d=C.parsePost(raw());C.set(d,'title','new title');C.set(d,'title','new title');const actual=yaml.load(C.splitFront(C.stringifyPost(d)).front.join('\n')).title;result('X01','Repeated field value loses serialized change','new title',actual,actual==='new title');}
  {const d=C.createPost({title:'true',description:'null',tags:['a,b','x[y]','false','001']});const t=C.stringifyPost(d);let value,error;try{value=yaml.load(C.splitFront(t).front.join('\n'));}catch(e){error=e.message;}result('X02','YAML scalar and flow tag safety','string values and exactly four tags',{yaml:t,parsed:value,error},!error&&typeof value.title==='string'&&value.tags.length===4&&value.tags.every(x=>typeof x==='string'));}
  {const dates=['2026-11-21 12:99:00','2026-11-21 12:00:99','2026-11-21 24:00:00','2026-02-30 10:00:00'];result('X03','Reject out-of-range date components','all null',dates.map(x=>({input:x,parsed:C.parseDate(x)&&C.formatDateTime(C.parseDate(x))})),dates.every(x=>C.parseDate(x)===null));}
  {const text='\uFEFF'+raw();const t=C.stringifyPost(C.parsePost(text));result('X04','BOM byte roundtrip',true,{equal:t===text,first:t.charCodeAt(0)},t===text);}
  {const text=raw().replace('title: A','# important header\ntitle: A');const t=C.stringifyPost(C.parsePost(text));result('X05','Leading front matter comment roundtrip',true,{equal:t===text,output:t},t===text);}
  {const s=await session();s.E.setBody('A edited');s.E.openPost(s.E.state.posts.find(p=>p.name==='b.md'),{skipDraftCheck:true});s.E.setBody('B unsaved');await s.E.savePost();const a=s.E.state.posts.find(p=>p.name==='a.md');result('X06','Saving B keeps dirty A in list','A edited, dirty=true',{body:a.doc.body,dirty:a.dirty,draft:!!s.w.localStorage.getItem(s.E.draftKey(a))},a.doc.body==='A edited'&&a.dirty);await finish(s);}
  {const s=await session();const sub=new Dir('nested');s.posts.dirs.set('nested',sub);sub.files.set('c.md',raw('nested'));await s.E.fs.loadAll();s.E.openPost(s.E.state.posts.find(p=>p.path==='nested/c.md'),{skipDraftCheck:true});s.E.setBody('nested edit');await s.E.savePost();result('X07','Saving nested article preserves directory','nested/c.md updated, no root c.md',{nested:sub.files.get('c.md'),root:s.posts.files.get('c.md'),selected:s.E.state.current?.path},sub.files.get('c.md').endsWith('nested edit')&&!s.posts.files.has('c.md'));await finish(s);}
  {const s=await session();const sub=new Dir('nested');s.posts.dirs.set('nested',sub);sub.files.set('a.md',raw('nested'));await s.E.fs.loadAll();s.E.openPost(s.E.state.posts.find(p=>p.path==='nested/a.md'),{skipDraftCheck:true});const pending=s.E.deletePost();modalButton(s.d,'删除');await pending;result('X08','Deleting nested article deletes correct file','root a.md stays; nested/a.md removed',{rootExists:s.posts.files.has('a.md'),nestedExists:sub.files.has('a.md')},s.posts.files.has('a.md')&&!sub.files.has('a.md'));await finish(s);}
  {const s=await session();const before=s.posts.files.get('b.md');s.E.loadFromText('b.md',raw('NEW','replacement'),{isNew:true,dirty:true});const pending=s.E.savePost();await sleep(30);const beforeChoice=s.posts.files.get('b.md');modalButton(s.d,'取消');await pending;result('X09','New collision is confirmed before write','original preserved',{beforeChoice,after:s.posts.files.get('b.md')},beforeChoice===before&&s.posts.files.get('b.md')===before);await finish(s);}
  {const s=await session();const before=s.posts.files.get('b.md');s.E.setBody('rename replacement');s.E.form.fileName.value='b.md';const pending=s.E.savePost();await sleep(30);const beforeChoice=s.posts.files.get('b.md');modalButton(s.d,'覆盖文件');await sleep(30);const beforeRename=s.posts.files.get('b.md');modalButton(s.d,'删除旧文件');await pending;result('X10','Rename collision decision precedes both writes','target unchanged before both decisions; move succeeds',{beforeChoice,beforeRename,rootA:s.posts.files.has('a.md')},beforeChoice===before&&beforeRename===before&&!s.posts.files.has('a.md')&&s.posts.files.get('b.md').endsWith('rename replacement'));await finish(s);}
  {const s=await session();s.E.setBody('save as body');s.d.querySelector('#btn-saveas').click();s.d.querySelector('#modal-body input').value='no-extension';modalButton(s.d,'确定');await sleep(100);result('X11','Save As adds markdown extension','no-extension.md visible in list',{files:[...s.posts.files.keys()],listed:s.E.state.posts.map(p=>p.name)},s.posts.files.has('no-extension.md'));await finish(s);}
  {const s=await session();input(s,'#f-title','');s.d.querySelector('#btn-saveas').click();s.d.querySelector('#modal-body input').value='invalid.md';modalButton(s.d,'确定');await sleep(100);result('X12','Save As respects validation','invalid title blocks write',{fileCreated:s.posts.files.has('invalid.md'),text:s.posts.files.get('invalid.md')},!s.posts.files.has('invalid.md'));await finish(s);}
  {const s=await session();const project2=new Dir('second'),src2=new Dir('source'),posts2=new Dir('_posts'),images2=new Dir('images');project2.dirs.set('source',src2);src2.dirs.set('_posts',posts2);src2.dirs.set('images',images2);posts2.files.set('a.md',raw('Second'));await s.E.fs.attach(project2);result('X13','Switch project also switches automatic image directory','second/source/images',{stillFirstProject:s.E.state.imagesDir===s.images,isSecond:s.E.state.imagesDir===images2},s.E.state.imagesDir===images2);await finish(s);}
  {const s=await session();const before=s.E.getBody();s.E.form.title.focus();s.E.form.title.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'b',ctrlKey:true,bubbles:true,cancelable:true}));result('X14','Ctrl+B in title does not modify body',before,s.E.getBody(),s.E.getBody()===before);await finish(s);}
  {const s=await session();s.E.setBody('saved snapshot');s.posts.delay=100;const pending=s.E.savePost();await sleep(20);s.E.setBody('typed during disk write');await pending;result('X15','Edits during async save survive','typed during disk write, dirty=true',{body:s.E.getBody(),dirty:s.E.state.current.dirty,disk:s.posts.files.get('a.md')},s.E.getBody()==='typed during disk write'&&s.E.state.current.dirty);await finish(s);}
  {const s=await session();await s.E.duplicatePost();const copy=s.E.state.current;result('X16','Duplicate gets a distinct permalink','empty or distinct abbrlink',{original:'abcdef12',copy:s.w.HexoCore.get(copy.doc,'abbrlink')},s.w.HexoCore.get(copy.doc,'abbrlink')!=='abcdef12');await finish(s);}
  {const s=await session();s.E.setBody('reference[^3]\n\n[^3]: existing note');s.E.setSel(0);s.E.action('footnote');const body=s.E.getBody();const definitions=[...body.matchAll(/^\[\^(\d+)\]:/gm)].map(m=>m[1]);result('X17','Sparse footnotes avoid duplicate identifiers','all definition numbers unique',{body,definitions},new Set(definitions).size===definitions.length);await finish(s);}
  {const block=C.buildVideoBlock({bvid:'BV1xx411c7mD',youtube:'dQw4w9WgXcQ',auto:true});const html=block+'\n'+block;const dom=new JSDOM(html);const doc=dom.window.document;const scripts=[...doc.querySelectorAll('script')];let executingScript;Object.defineProperty(doc,'currentScript',{get:()=>executingScript});for(const script of scripts){executingScript=script;await vm.runInNewContext(script.textContent,{checkGoogle:()=>Promise.resolve(1),document:doc});}result('X19','Two auto video blocks each initialize','both containers have iframe',{containers:doc.querySelectorAll('[id^="videoContainer-"]').length,iframesPerContainer:[...doc.querySelectorAll('[id^="videoContainer-"]')].map(x=>x.querySelectorAll('iframe').length)},[...doc.querySelectorAll('[id^="videoContainer-"]')].every(x=>x.querySelector('iframe')));dom.window.close();}
  {const s=await session();s.w.console.error=()=>{};s.posts.failWrite=true;s.E.setBody('must retain on failure');await s.E.savePost();result('P01','Write failure keeps dirty content','content kept, dirty=true',{body:s.E.getBody(),dirty:s.E.state.current.dirty,toast:s.d.querySelector('#toast').textContent},s.E.getBody()==='must retain on failure'&&s.E.state.current.dirty);await finish(s);}
  {const s=await session();const text='<img src=x onerror="window.__xss=1">\n<script>window.__xss=2</script>';s.E.setBody(text);s.E.setSel(text.length);result('P02','Raw HTML displayed without execution','no actual img/script nodes, text intact',{img:s.E.form.body.querySelectorAll('img').length,script:s.E.form.body.querySelectorAll('script').length,xss:s.w.__xss,roundtrip:s.E.getBody()===text},!s.w.__xss&&!s.E.form.body.querySelector('script,img')&&s.E.getBody()===text);await finish(s);}
  {const s=await session();input(s,'#f-date','2026-11-22 11:22:33');s.E.form.date.dispatchEvent(new s.w.Event('blur'));const inMemory=s.w.HexoCore.get(s.E.state.current.doc,'date');await s.E.savePost();const onDisk=s.posts.files.get('a.md').match(/^date: (.*)$/m)[1];result('X20','Real input then blur preserves changed date','2026-11-22 11:22:33',{inMemory,onDisk,afterSave:s.E.form.date.value},onDisk==='2026-11-22 11:22:33');await finish(s);}
  {const s=await session();s.E.addTag('x[y]');await s.E.savePost();let error;try{yaml.load(C.splitFront(s.posts.files.get('a.md')).front.join('\n'));}catch(e){error=e.message;}result('X21','UI tag with brackets produces valid YAML','valid YAML',{error},!error);await finish(s);}
  {const s=await session();s.E.setBody('post one draft');s.E.openPost(s.E.state.posts.find(p=>p.name==='b.md'),{skipDraftCheck:true});const project2=new Dir('project2'),source=new Dir('source'),posts2=new Dir('_posts');project2.dirs.set('source',source);source.dirs.set('_posts',posts2);posts2.files.set('a.md',raw('Different project','project 2 disk'));await s.E.fs.attach(project2);s.E.openPost(s.E.state.posts[0]);await sleep(20);result('X22','Drafts isolated across projects','no draft from project one',{modal:s.d.querySelector('#modal-title').textContent,hidden:s.d.querySelector('#modal').classList.contains('hidden'),preview:s.d.querySelector('#modal-body').textContent},s.d.querySelector('#modal').classList.contains('hidden'));await finish(s);}
  {const s=await session();input(s,'#f-title','true');await s.E.savePost();let val=yaml.load(C.splitFront(s.posts.files.get('a.md')).front.join('\n')).title;result('X23','Boolean-like title stays a string','string true',{value:val,type:typeof val},typeof val==='string'&&val==='true');await finish(s);}
  {const s=await session();s.E.setBody('just typed');s.E.undo();result('X24','Immediate undo operates before debounce','disk body',s.E.getBody(),s.E.getBody()==='disk body');await finish(s);}
  {const s=await session();const pending=s.E.newPost();s.d.querySelector('#modal-body input').value='unsaved new';modalButton(s.d,'确定');await pending;s.E.setBody('new article draft');s.E.openPost(s.E.state.posts.find(p=>p.name==='b.md'),{skipDraftCheck:true});const savedKeys=Object.keys(s.w.localStorage).filter(k=>k.includes('draft:'));await s.E.fs.reload();result('X25','Unsaved new draft discoverable after disk reload','new article can be recovered from visible entry or prompt',{savedKeys,list:s.E.state.posts.map(p=>p.name),modal:s.d.querySelector('#modal-title').textContent,modalHidden:s.d.querySelector('#modal').classList.contains('hidden')},s.E.state.posts.some(p=>p.name.includes('unsaved new'))||!s.d.querySelector('#modal').classList.contains('hidden'));await finish(s);}
  {const s=await session();s.E.fs.readImage=async()=>{await sleep(80);return {image:true};};input(s,'#f-cover','/images/slow.png');s.d.querySelector('#btn-cover-clear').click();await sleep(120);result('X26','Clearing cover cancels older pending preview','no preview background',{cover:s.E.form.cover.value,background:s.d.querySelector('#cover-preview').style.backgroundImage},s.d.querySelector('#cover-preview').style.backgroundImage==='');await finish(s);}

  // 组合操作回归：验证修复没有在切换文章、撤销和恢复时引入丢稿。
  {
    const tags = ['a,b', "it's fine", 'x[y]', 'true', '001', 'a"b'];
    const doc = C.createPost({title: 'on', tags});
    const text = C.stringifyPost(doc);
    const parsed = yaml.load(C.splitFront(text).front.join('\n'));
    result('R01', 'Quoted tags survive editor and YAML parsers', tags,
      C.get(C.parsePost(text), 'tags'),
      JSON.stringify(C.get(C.parsePost(text), 'tags')) === JSON.stringify(tags) &&
      JSON.stringify(parsed.tags) === JSON.stringify(tags) && parsed.title === 'on');
  }
  {
    const text = '\uFEFF' + raw().replace(/\n/g, '\r\n').replace('title: A', '# heading comment\r\ntitle: A');
    const doc = C.parsePost(text);
    C.set(doc, 'title', 'changed');
    C.set(doc, 'title', 'A');
    result('R02', 'Reverting a field keeps original bytes including BOM/comment/CRLF', text,
      C.stringifyPost(doc), C.stringifyPost(doc) === text);
  }
  {
    const s = await session();
    const a = s.E.state.current;
    s.posts.delay = 80;
    s.E.setBody('A saved snapshot');
    const saving = s.E.savePost();
    await sleep(10);
    s.E.setBody('A input while saving');
    s.E.openPost(s.E.state.posts.find(p => p.name === 'b.md'), {skipDraftCheck: true});
    s.E.setBody('B input');
    await saving;
    const draft = JSON.parse(s.w.localStorage.getItem(s.E.draftKey(a)) || 'null');
    result('R03', 'Saving A does not steal B or discard post-save input', 'B selected, both edits retained',
      {selected:s.E.state.current.name, body:s.E.getBody(), draft:draft?.text},
      s.E.state.current.name === 'b.md' && s.E.getBody() === 'B input' &&
      a.dirty && a.doc.body === 'A input while saving' && draft.text.endsWith('A input while saving'));
    await finish(s);
  }
  {
    const s = await session();
    s.posts.delay = 50;
    s.E.setBody('one save');
    await Promise.all([s.E.savePost(), s.E.savePost()]);
    result('R04', 'Repeated save clicks serialize one write', 1, s.posts.writes, s.posts.writes === 1);
    await finish(s);
  }
  {
    const s = await session();
    const sub = new Dir('nested');
    s.posts.dirs.set('nested', sub);
    sub.files.set('c.md', raw('nested'));
    await s.E.fs.loadAll();
    s.E.openPost(s.E.state.posts.find(p=>p.path === 'nested/c.md'), {skipDraftCheck: true});
    s.E.form.fileName.value = 'renamed.md';
    const saving = s.E.savePost();
    await sleep(20);
    modalButton(s.d, '删除旧文件');
    await saving;
    result('R05', 'Nested rename stays in its own directory', 'nested/renamed.md',
      s.E.state.current.path, s.E.state.current.path === 'nested/renamed.md' &&
      !sub.files.has('c.md') && sub.files.has('renamed.md') && !s.posts.files.has('renamed.md') && s.posts.files.has('a.md'));
    await finish(s);
  }
  {
    const s = await session();
    const original = s.posts.files.get('b.md');
    const saving = s.E.savePost({saveAs: true, name: 'b.md'});
    await sleep(20);
    modalButton(s.d, '取消');
    await saving;
    result('R06', 'Cancel Save As collision leaves both originals intact', original,
      s.posts.files.get('b.md'), s.posts.files.get('b.md') === original && s.E.state.current.name === 'a.md');
    await finish(s);
  }
  {
    const s = await session();
    const original = s.posts.files.get('a.md');
    await s.E.savePost({saveAs:true, name:'a.md'});
    result('R07', 'Save As requires a different target', original, s.posts.files.get('a.md'),
      s.posts.files.get('a.md') === original && s.posts.writes === undefined);
    await finish(s);
  }
  {
    const s = await session();
    s.E.setBody('first');
    s.E.undo();
    await sleep(500);
    s.E.redo();
    const afterRedo = s.E.getBody();
    s.E.undo();
    s.E.setBody('new branch');
    s.E.redo();
    result('R08', 'Undo debounce preserves redo and new editing branches', 'first, then new branch',
      {afterRedo, afterBranch:s.E.getBody()}, afterRedo === 'first' && s.E.getBody() === 'new branch');
    await finish(s);
  }
  {
    const s = await session();
    const creating = s.E.newPost();
    s.d.querySelector('#modal-body input').value = 'recovered draft';
    modalButton(s.d, '确定');
    await creating;
    s.E.setBody('never saved content');
    s.E.closeEditor();
    s.E.state.posts = [];
    await s.E.fs.loadAll();
    const recovered = s.E.state.posts.find(p=>p.name.includes('recovered draft'));
    result('R09', 'Disk-only reload rediscovers a never-saved draft', 'dirty draft with content', recovered?.doc.body,
      !!recovered && recovered.dirty && recovered.isNew && recovered.doc.body === 'never saved content');
    s.E.openPost(recovered);
    modalButton(s.d, '恢复草稿');
    await sleep(20);
    result('R10', 'Restored new draft stays new and keeps date locked', true, s.E.form.date.disabled,
      s.E.state.current.isNew && !s.E.state.current.savedOnce && s.E.form.date.disabled);
    await finish(s);
  }
  {
    const s = await session();
    const beforeScope = s.E.state.projectId;
    s.E.setBody('same project draft');
    await s.E.fs.attach(s.posts);
    const p = s.E.state.posts.find(p=>p.name === 'a.md');
    result('R11', 'Root and _posts handles use the same project namespace', beforeScope,
      s.E.state.projectId, s.E.state.projectId === beforeScope && !!s.w.localStorage.getItem(s.E.draftKey(p)));
    await finish(s);
  }
  {
    const s = await session();
    const legacyKey = 'hexo-editor:draft:legacy.md';
    s.w.localStorage.setItem(legacyKey, JSON.stringify({at:Date.now(), text:raw('legacy', 'legacy content')}));
    const importing = s.E.importLegacyDrafts();
    modalButton(s.d, '导入到当前目录');
    await importing;
    result('R12', 'Legacy drafts migrate only through explicit project choice', 'draft listed, no disk write',
      {files:[...s.posts.files.keys()], listed:s.E.state.posts.map(p=>p.name)},
      !s.w.localStorage.getItem(legacyKey) && s.E.state.posts.some(p=>p.name === 'legacy.md' && p.dirty) &&
      !s.posts.files.has('legacy.md'));
    await finish(s);
  }
  {
    const s = await session();
    let rejected = false;
    try { await s.E.fs.remove('../a.md'); } catch { rejected = true; }
    result('R13', 'Invalid relative paths cannot escape the posts directory', true, rejected,
      rejected && s.posts.files.has('a.md'));
    await finish(s);
  }
  {
    const s = await session();
    const p = s.E.state.current;
    s.E.setBody('dirty article to delete');
    const deleting = s.E.deletePost();
    modalButton(s.d, '删除');
    await deleting;
    await s.E.fs.loadAll();
    result('R14', 'Deleting a dirty post cannot recreate it as an orphan draft', 'no article or draft',
      {listed:s.E.state.posts.map(p=>p.path), draft:s.w.localStorage.getItem(s.E.draftKey(p))},
      !s.E.state.posts.some(x=>x.path === p.path) && !s.w.localStorage.getItem(s.E.draftKey(p)));
    await finish(s);
  }
  {
    const s = await session();
    const manual = new Dir('images');
    s.E.state.imagesDir = manual;
    s.E.state.imagesSource = 'manual';
    s.E.state.imagesScope = s.E.state.projectId;
    await s.E.fs.attach(s.project);
    result('R15', 'Manual image directory survives reconnecting the same project', true,
      s.E.state.imagesDir === manual, s.E.state.imagesDir === manual);
    await finish(s);
  }
  {
    const s = await session();
    const p = s.E.state.current;
    s.posts.delay = 60;
    const saving = s.E.savePost();
    await sleep(10);
    s.E.form.fileName.value = 'pending.md';
    s.E.form.fileName.dispatchEvent(new s.w.Event('change'));
    await saving;
    result('R16', 'Filename edits during save stay pending for the next save', 'pending.md, dirty',
      {input:s.E.form.fileName.value, dirty:p.dirty, path:p.path},
      s.E.form.fileName.value === 'pending.md' && p.dirty && p.path === 'a.md');
    await finish(s);
  }
  {
    const s = await session();
    const p = s.E.state.current;
    s.E.setBody('local draft');
    s.E.closeEditor();
    s.posts.files.set('a.md', raw('A', 'new disk version from another editor'));
    s.E.openPost(p);
    modalButton(s.d, '用磁盘上的版本');
    await sleep(20);
    result('R17', 'Discard rereads the latest disk version rather than an old baseline', 'new disk version from another editor',
      s.E.getBody(), s.E.getBody() === 'new disk version from another editor' && !p.dirty && !s.w.localStorage.getItem(s.E.draftKey(p)));
    await finish(s);
  }
  {
    const s = await session();
    const p = s.E.state.current;
    const external = raw('A', 'externally edited');
    s.E.setBody('my edits');
    s.posts.files.set('a.md', external);
    await s.E.fs.loadAll();
    const saving = s.E.savePost();
    await sleep(20);
    modalButton(s.d, '保留编辑稿');
    await saving;
    result('R18', 'Refresh and save retain both versions on conflict', 'external file and dirty buffer',
      [s.posts.files.get('a.md'), p.doc.body], s.posts.files.get('a.md') === external && p.dirty && p.doc.body === 'my edits');
    const override = s.E.savePost();
    await sleep(20);
    modalButton(s.d, '确认覆盖磁盘版本');
    await override;
    result('R19', 'Explicit overwrite writes the chosen snapshot', 'my edits',
      s.posts.files.get('a.md'), s.posts.files.get('a.md').endsWith('my edits') && !p.dirty);
    await finish(s);
  }
  {
    const s = await session();
    const p = s.E.state.current;
    s.E.form.date.dispatchEvent(new s.w.Event('blur'));
    result('R20', 'Date focus change without edit stays clean', false, p.dirty, !p.dirty);
    s.E.form.fileName.value = 'renamed.md';
    s.E.form.fileName.dispatchEvent(new s.w.Event('change'));
    s.E.closeEditor();
    p.pendingName = null;
    s.E.openPost(p);
    modalButton(s.d, '恢复草稿');
    await sleep(20);
    result('R21', 'Filename-only draft restores pending name', 'renamed.md',
      s.E.form.fileName.value, s.E.form.fileName.value === 'renamed.md' && p.dirty);
    await s.E.duplicatePost();
    const copy = s.E.state.current;
    result('R22', 'Copies without explicit links get a distinct CRC32', 'distinct title and CRC32',
      C.get(copy.doc, 'title'), C.predictAbbrlink(C.get(copy.doc, 'title')) !== C.predictAbbrlink(C.get(p.doc, 'title')));
    await finish(s);
  }
  const failed = results.filter(x=>!x.pass).length;
  console.log('Regression checks '+checks+', failed '+failed);
  process.exitCode = failed ? 1 : 0;
}
main().catch(e=>{console.error(e);process.exitCode=1;});

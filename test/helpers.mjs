import fs from 'node:fs';
import path from 'node:path';

export function findPostsDir(here) {
  if (process.env.HEXO_EDITOR_POSTS_DIR) {
    const configured = path.resolve(process.env.HEXO_EDITOR_POSTS_DIR);
    if (!fs.existsSync(configured)) throw new Error('HEXO_EDITOR_POSTS_DIR does not exist: ' + configured);
    return configured;
  }
  for (const rel of ['../../source/_posts', '../../../source/_posts', '../source/_posts', './fixtures/posts']) {
    const candidate = path.resolve(here, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('No post corpus found; use the bundled fixtures or HEXO_EDITOR_POSTS_DIR.');
}

/** 语料目录里的全部 .md（按文件名排序，保证跨机器顺序一致） */
export function listPosts(postsDir) {
  return fs.readdirSync(postsDir).filter((f) => f.endsWith('.md')).sort();
}

export function readPost(postsDir, name) {
  return fs.readFileSync(path.join(postsDir, name), 'utf8');
}

/**
 * 按特征挑一篇语料，避免测试绑定某个具体文件名。
 * 内置 fixtures 与真实博客目录都能用；找不到直接报错，不做静默降级。
 * @param {string} postsDir
 * @param {(raw:string, name:string)=>boolean|null} predicate
 * @param {string} label 找不到时的提示
 * @returns {{name:string, raw:string}}
 */
export function pickPost(postsDir, predicate, label) {
  for (const name of listPosts(postsDir)) {
    const raw = readPost(postsDir, name);
    if (!predicate || predicate(raw, name)) return { name, raw };
  }
  throw new Error('No post matches ' + (label || 'the predicate') + ' in ' + postsDir);
}

export async function waitForBoot(dom) {
  const deadline = Date.now() + 3000;
  while (!dom.window.HexoEditor?.state.booted) {
    if (Date.now() > deadline) throw new Error('Editor did not finish booting');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

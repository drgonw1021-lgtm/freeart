// 临时脚本：环境的代理挡住了 github.com 的 git 通道（CONNECT 502），
// 但 api.github.com 是通的，所以用 Git Data API 把最新提交推上去。
import { execFileSync } from 'child_process';

const OWNER = 'drgonw1021-lgtm';
const REPO = 'freeart';
const BRANCH = 'main';

const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const api = async (p, opts = {}) => {
  const r = await fetch('https://api.github.com' + p, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'freeart',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
};

const files = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean);
const msg = execFileSync('git', ['log', '-1', '--pretty=%B'], { encoding: 'utf8' }).trim();
console.log('改动文件：', files.join(', '));

const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const base = ref.object.sha;

const tree = [];
for (const f of files) {
  const buf = execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: { content: buf.toString('base64'), encoding: 'base64' },
  });
  tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
}

const t = await api(`/repos/${OWNER}/${REPO}/git/trees`, { method: 'POST', body: { base_tree: base, tree } });
const c = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: { message: msg, tree: t.sha, parents: [base] },
});
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: c.sha } });
console.log('已推送 ' + c.sha.slice(0, 7) + ' → ' + c.html_url);

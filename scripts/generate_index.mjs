#!/usr/bin/env node
import { readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { dirname } from 'node:path';

const DOCS_DIR = resolve(__dirname, '..', 'docs');

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];

function main() {
  let files = [];
  try {
    files = readdirSync(DOCS_DIR)
      .filter((f) => f.startsWith('ppd-') && f.endsWith('.html'))
      .sort()
      .reverse();
  } catch {
    console.error('[WARN] docs/ directory not found');
    return;
  }

  let links = '';
  for (const f of files.slice(0, 30)) {
    const date = f.replace('ppd-', '').replace('.html', '');
    let dateDisplay = date;
    let weekday = '';
    try {
      const d = new Date(date + 'T00:00:00+08:00');
      dateDisplay = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
      weekday = weekdayNames[d.getDay()];
    } catch { /* keep raw */ }
    links += `<li><a href="${esc(f)}">\uD83D\uDCC5 ${esc(dateDisplay)}（週${weekday}）</a></li>\n`;
  }

  const total = files.length;

  const index = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>PPD Research Daily &middot; 產後憂鬱症研究文獻日報</title>
<style>
  :root{--bg:#f6f1e8;--surface:#fffaf2;--line:#d8c5ab;--text:#2b2118;--muted:#766453;--accent:#8c4f2b;--accent-soft:#ead2bf}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:radial-gradient(circle at top,#fff6ea 0,var(--bg) 55%,#ead8c6 100%);color:var(--text);font-family:"Noto Sans TC","PingFang TC","Helvetica Neue",Arial,sans-serif;min-height:100vh}
  .container{position:relative;z-index:1;max-width:640px;margin:0 auto;padding:80px 24px}
  .logo{font-size:48px;text-align:center;margin-bottom:16px}
  h1{text-align:center;font-size:24px;color:var(--text);margin-bottom:8px}
  .subtitle{text-align:center;color:var(--accent);font-size:14px;margin-bottom:48px}
  .count{text-align:center;color:var(--muted);font-size:13px;margin-bottom:32px}
  ul{list-style:none}
  li{margin-bottom:8px}
  a{color:var(--text);text-decoration:none;display:block;padding:14px 20px;background:var(--surface);border:1px solid var(--line);border-radius:12px;transition:all .2s;font-size:15px}
  a:hover{background:var(--accent-soft);border-color:var(--accent);transform:translateX(4px)}
  .links-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:40px}
  .link-card{display:flex;align-items:center;gap:10px;padding:14px 16px;background:var(--surface);border:1px solid var(--line);border-radius:16px;text-decoration:none;color:var(--text);transition:all .2s;font-size:13px}
  .link-card:hover{border-color:var(--accent);transform:translateY(-2px)}
  .link-icon{font-size:22px;flex-shrink:0}
  .link-info{flex:1}
  .link-title{font-weight:700;font-size:13px}
  .link-desc{font-size:10px;color:var(--muted)}
  footer{margin-top:40px;text-align:center;font-size:12px;color:var(--muted)}
  footer a{display:inline;padding:0;background:none;border:none;color:var(--muted)}
  footer a:hover{color:var(--accent)}
  @media(max-width:600px){.links-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="container">
  <div class="logo">\uD83E\uDD31</div>
  <h1>PPD Research Daily</h1>
  <p class="subtitle">產後憂鬱症研究文獻日報 &middot; 每日自動更新</p>
  <p class="count">共 ${total} 期日報</p>
  <ul>${links}</ul>
  <div class="links-grid">
    <a href="https://www.leepsyclinic.com/" class="link-card" target="_blank" rel="noopener">
      <span class="link-icon">\uD83C\uDFE5</span>
      <span class="link-info"><span class="link-title">李政洋身心診所</span><span class="link-desc">診所首頁</span></span>
    </a>
    <a href="https://blog.leepsyclinic.com/" class="link-card" target="_blank" rel="noopener">
      <span class="link-icon">\uD83D\uDCF0</span>
      <span class="link-info"><span class="link-title">訂閱電子報</span><span class="link-desc">最新衛教資訊</span></span>
    </a>
    <a href="https://buymeacoffee.com/CYlee" class="link-card" target="_blank" rel="noopener">
      <span class="link-icon">\u2615</span>
      <span class="link-info"><span class="link-title">Buy Me a Coffee</span><span class="link-desc">支持本研究計畫</span></span>
    </a>
  </div>
  <footer>
    <p>Powered by PubMed + Zhipu AI &middot; <a href="https://github.com/u8901006/postpartum-depression">GitHub</a></p>
  </footer>
</div>
</body>
</html>`;

  writeFileSync(join(DOCS_DIR, 'index.html'), index, 'utf-8');
  console.error('[INFO] Index page generated');
}

main();

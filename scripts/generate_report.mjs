#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_BASE = process.env.ZHIPU_API_BASE || 'https://open.bigmodel.cn/api/coding/paas/v4';
const MODEL_CHAIN = ['glm-5-turbo', 'glm-4.7', 'glm-4.7-flash'];

const PPD_TAGS = [
  '篩檢與診斷', '藥物治療', '心理治療', '神經科學', '生物標記',
  '營養與生活方式', '母嬰關係', '嬰兒發展', '社會文化因素',
  '流行病學', '護理與助產', '伴侶與家庭', '數位介入',
  '公共衛生', '系統性回顧', '母乳哺餵', '睡眠醫學',
  '助生殖與不孕', '兒少精神醫學', '跨文化研究',
];

const SYSTEM_PROMPT =
  '你是產後憂鬱症（Postpartum Depression, PPD）領域的資深研究員與科學傳播者。你的任務是：\n' +
  '1. 從提供的醫學文獻中，篩選出最具臨床意義與研究價值的 PPD 論文\n' +
  '2. 對每篇論文進行繁體中文摘要、分類、PICO 分析\n' +
  '3. 評估其臨床實用性（高/中/低）\n' +
  '4. 生成適合醫療專業人員與關注產後心理健康人士閱讀的日報\n\n' +
  '輸出格式要求：\n' +
  '- 語言：繁體中文（台灣用語）\n' +
  '- 專業但易懂\n' +
  '- 每篇論文需包含：中文標題、一句話總結、PICO分析（top picks）、臨床實用性、分類標籤\n' +
  '- 最後提供今日精選 TOP 3（最重要/最影響臨床實踐的論文）\n' +
  '回傳格式必須是純 JSON，不要用 markdown code block 包裹。';

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadDedupState(dedupPath) {
  try {
    if (existsSync(dedupPath)) {
      return JSON.parse(readFileSync(dedupPath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { last_updated: '', summarized_pmids: {} };
}

function pruneOldEntries(state, maxAgeDays = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const pruned = {};
  for (const [pmid, date] of Object.entries(state.summarized_pmids || {})) {
    if (date >= cutoffStr) pruned[pmid] = date;
  }
  return { ...state, summarized_pmids: pruned };
}

function filterNewPapers(papers, state) {
  return papers.filter((p) => !state.summarized_pmids[p.pmid]);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: '', output: '', date: '', apiKey: process.env.ZHIPU_API_KEY || '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) opts.input = args[++i];
    if (args[i] === '--output' && args[i + 1]) opts.output = args[++i];
    if (args[i] === '--date' && args[i + 1]) opts.date = args[++i];
    if (args[i] === '--api-key' && args[i + 1]) opts.apiKey = args[++i];
  }
  return opts;
}

function robustJsonParse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    cleaned = firstNewline >= 0 ? cleaned.slice(firstNewline + 1) : cleaned.slice(3);
    cleaned = cleaned.replace(/```+\s*$/g, '').trim();
  }
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
    cleaned = cleaned.replace(/```+\s*$/g, '').trim();
  }

  cleaned = cleaned.replace(/[\x00-\x1f]/g, (ch) => {
    if (ch === '\n' || ch === '\r' || ch === '\t') return ch;
    return '';
  });

  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    console.error(`[WARN] First JSON parse failed: ${e1.message}`);
  }

  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(cleaned);
  } catch (e2) {
    console.error(`[WARN] Second JSON parse (trailing commas fixed) failed: ${e2.message}`);
  }

  for (let i = cleaned.length; i > 10; i--) {
    const sub = cleaned.slice(0, i);
    const lastBrace = sub.lastIndexOf('}');
    if (lastBrace > 0) {
      try {
        return JSON.parse(sub.slice(0, lastBrace + 1));
      } catch { /* continue */ }
    }
  }

  throw new Error('All JSON parse attempts failed');
}

function buildPrompt(papersData, dateStr) {
  const paperCount = papersData.count || 0;
  const papersText = JSON.stringify(papersData.papers || [], null, 2);
  const tagsList = PPD_TAGS.join('、');

  return `以下是 ${dateStr} 從 PubMed 抓取的最新產後憂鬱症（PPD）相關文獻（共 ${paperCount} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢與亮點（聚焦產後憂鬱症領域）",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（繁體中文，點出核心發現與臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "相關emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "篩檢與診斷": 3,
    "藥物治療": 2
  }
}

原始文獻資料：
${papersText}

請篩選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：${tagsList}
記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;
}

async function analyzePapers(apiKey, papersData, dateStr) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const prompt = buildPrompt(papersData, dateStr);

  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const resp = await fetch(`${API_BASE}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: prompt },
            ],
            temperature: 0.3,
            top_p: 0.9,
            max_tokens: 50000,
          }),
          signal: AbortSignal.timeout(480000),
        });

        if (resp.status === 429) {
          const wait = 60000 * (attempt + 1);
          console.error(`[WARN] Rate limited, waiting ${wait / 1000}s...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          console.error(`[ERROR] ${model} HTTP ${resp.status}: ${body.slice(0, 200)}`);
          break;
        }

        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content || '';
        if (!text) throw new Error('Empty response from API');

        const result = robustJsonParse(text);

        const topPicks = Array.isArray(result.top_picks) ? result.top_picks : [];
        const allPapers = Array.isArray(result.all_papers) ? result.all_papers : [];
        console.error(
          `[INFO] ${model} success: ${topPicks.length} top picks, ${allPapers.length} total`
        );
        return {
          date: result.date || dateStr,
          market_summary: result.market_summary || '',
          top_picks: topPicks,
          all_papers: allPapers,
          keywords: Array.isArray(result.keywords) ? result.keywords : [],
          topic_distribution: result.topic_distribution || {},
          _model: model,
        };
      } catch (err) {
        console.error(`[WARN] ${model} attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  return null;
}

function generateHtml(analysis, modelUsed) {
  const dateStr = analysis.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const parts = dateStr.split('-');
  const dateDisplay = parts.length === 3 ? `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日` : dateStr;

  const summary = esc(analysis.market_summary || '');
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const totalCount = topPicks.length + allPapers.length;

  let topPicksHtml = '';
  for (const pick of topPicks) {
    const tagsHtml = (pick.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const util = pick.clinical_utility || '中';
    const utilCls = util === '高' ? 'utility-high' : util === '中' ? 'utility-mid' : 'utility-low';
    const pico = pick.pico || {};
    const picoHtml = Object.keys(pico).length
      ? `<div class="pico-grid">
  <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${esc(pico.population || '-')}</span></div>
  <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${esc(pico.intervention || '-')}</span></div>
  <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${esc(pico.comparison || '-')}</span></div>
  <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${esc(pico.outcome || '-')}</span></div>
</div>`
      : '';

    topPicksHtml += `<div class="news-card featured">
  <div class="card-header">
    <span class="rank-badge">#${esc(pick.rank || '')}</span>
    <span class="emoji-icon">${esc(pick.emoji || '\uD83D\uDCC4')}</span>
    <span class="${utilCls}">${esc(util)}實用性</span>
  </div>
  <h3>${esc(pick.title_zh || pick.title_en || '')}</h3>
  <p class="journal-source">${esc(pick.journal || '')} &middot; ${esc(pick.title_en || '')}</p>
  <p>${esc(pick.summary || '')}</p>
  ${picoHtml}
  <div class="card-footer">
    ${tagsHtml}
    <a href="${esc(pick.url || '#')}" target="_blank" rel="noopener">閱讀原文 &rarr;</a>
  </div>
</div>`;
  }

  let allPapersHtml = '';
  for (const paper of allPapers) {
    const tagsHtml = (paper.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const util = paper.clinical_utility || '中';
    const utilCls = util === '高' ? 'utility-high' : util === '中' ? 'utility-mid' : 'utility-low';
    allPapersHtml += `<div class="news-card">
  <div class="card-header-row">
    <span class="emoji-sm">${esc(paper.emoji || '\uD83D\uDCC4')}</span>
    <span class="${utilCls} utility-sm">${esc(util)}</span>
  </div>
  <h3>${esc(paper.title_zh || paper.title_en || '')}</h3>
  <p class="journal-source">${esc(paper.journal || '')}</p>
  <p>${esc(paper.summary || '')}</p>
  <div class="card-footer">
    ${tagsHtml}
    <a href="${esc(paper.url || '#')}" target="_blank" rel="noopener">PubMed &rarr;</a>
  </div>
</div>`;
  }

  const keywordsHtml = keywords.map((k) => `<span class="keyword">${esc(k)}</span>`).join('');

  let topicBarsHtml = '';
  if (Object.keys(topicDist).length) {
    const maxCount = Math.max(...Object.values(topicDist), 1);
    for (const [topic, count] of Object.entries(topicDist)) {
      const widthPct = Math.round((count / maxCount) * 100);
      topicBarsHtml += `<div class="topic-row">
  <span class="topic-name">${esc(topic)}</span>
  <div class="topic-bar-bg"><div class="topic-bar" style="width:${widthPct}%"></div></div>
  <span class="topic-count">${count}</span>
</div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>PPD Research Daily &middot; 產後憂鬱症研究文獻日報 &middot; ${esc(dateDisplay)}</title>
<meta name="description" content="${esc(dateDisplay)} 產後憂鬱症研究文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
  :root{--bg:#f6f1e8;--surface:#fffaf2;--line:#d8c5ab;--text:#2b2118;--muted:#766453;--accent:#8c4f2b;--accent-soft:#ead2bf;--card-bg:color-mix(in srgb,var(--surface) 92%,white)}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:radial-gradient(circle at top,#fff6ea 0,var(--bg) 55%,#ead8c6 100%);color:var(--text);font-family:"Noto Sans TC","PingFang TC","Helvetica Neue",Arial,sans-serif;min-height:100vh;overflow-x:hidden}
  .container{position:relative;z-index:1;max-width:880px;margin:0 auto;padding:60px 32px 80px}
  header{display:flex;align-items:center;gap:16px;margin-bottom:52px;animation:fadeDown .6s ease both}
  .logo{width:48px;height:48px;border-radius:14px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;box-shadow:0 4px 20px rgba(140,79,43,.25)}
  .header-text h1{font-size:22px;font-weight:700;color:var(--text);letter-spacing:-.3px}
  .header-meta{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;letter-spacing:.3px}
  .badge-date{background:var(--accent-soft);border:1px solid var(--line);color:var(--accent)}
  .badge-count{background:rgba(140,79,43,.06);border:1px solid var(--line);color:var(--muted)}
  .badge-source{background:transparent;color:var(--muted);font-size:11px;padding:0 4px}
  .summary-card{background:var(--card-bg);border:1px solid var(--line);border-radius:24px;padding:28px 32px;margin-bottom:32px;box-shadow:0 20px 60px rgba(61,36,15,.06);animation:fadeUp .5s ease .1s both}
  .summary-card h2{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.6px;color:var(--accent);margin-bottom:16px}
  .summary-text{font-size:15px;line-height:1.8;color:var(--text)}
  .section{margin-bottom:36px;animation:fadeUp .5s ease both}
  .section-title{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:700;color:var(--text);margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--line)}
  .section-icon{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;background:var(--accent-soft)}
  .news-card{background:var(--card-bg);border:1px solid var(--line);border-radius:24px;padding:22px 26px;margin-bottom:12px;box-shadow:0 8px 30px rgba(61,36,15,.04);transition:background .2s,border-color .2s,transform .2s}
  .news-card:hover{transform:translateY(-2px);box-shadow:0 12px 40px rgba(61,36,15,.08)}
  .news-card.featured{border-left:3px solid var(--accent)}
  .news-card.featured:hover{border-color:var(--accent)}
  .card-header{display:flex;align-items:center;gap:8px;margin-bottom:10px}
  .rank-badge{background:var(--accent);color:#fff7f0;font-weight:700;font-size:12px;padding:2px 8px;border-radius:6px}
  .emoji-icon{font-size:18px}
  .card-header-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .emoji-sm{font-size:14px}
  .news-card h3{font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px;line-height:1.5}
  .journal-source{font-size:12px;color:var(--accent);margin-bottom:8px;opacity:.8}
  .news-card p{font-size:13.5px;line-height:1.75;color:var(--muted)}
  .card-footer{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
  .tag{padding:2px 9px;background:var(--accent-soft);border-radius:999px;font-size:11px;color:var(--accent)}
  .news-card a{font-size:12px;color:var(--accent);text-decoration:none;opacity:.7;margin-left:auto}
  .news-card a:hover{opacity:1}
  .utility-high{color:#5a7a3a;font-size:11px;font-weight:600;padding:2px 8px;background:rgba(90,122,58,.1);border-radius:4px}
  .utility-mid{color:#9f7a2e;font-size:11px;font-weight:600;padding:2px 8px;background:rgba(159,122,46,.1);border-radius:4px}
  .utility-low{color:var(--muted);font-size:11px;font-weight:600;padding:2px 8px;background:rgba(118,100,83,.08);border-radius:4px}
  .utility-sm{font-size:10px}
  .pico-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;padding:12px;background:rgba(255,253,249,.8);border-radius:14px;border:1px solid var(--line)}
  .pico-item{display:flex;gap:8px;align-items:baseline}
  .pico-label{font-size:10px;font-weight:700;color:#fff7f0;background:var(--accent);padding:2px 6px;border-radius:4px;flex-shrink:0}
  .pico-text{font-size:12px;color:var(--muted);line-height:1.4}
  .keywords-section{margin-bottom:36px}
  .keywords{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
  .keyword{padding:5px 14px;background:var(--accent-soft);border:1px solid var(--line);border-radius:20px;font-size:12px;color:var(--accent);cursor:default;transition:background .2s}
  .keyword:hover{background:rgba(140,79,43,.18)}
  .topic-section{margin-bottom:36px}
  .topic-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .topic-name{font-size:13px;color:var(--muted);width:100px;flex-shrink:0;text-align:right}
  .topic-bar-bg{flex:1;height:8px;background:var(--line);border-radius:4px;overflow:hidden}
  .topic-bar{height:100%;background:linear-gradient(90deg,var(--accent),#c47a4a);border-radius:4px;transition:width .6s ease}
  .topic-count{font-size:12px;color:var(--accent);width:24px}
  .links-banner{margin-top:48px;animation:fadeUp .5s ease .4s both}
  .links-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
  .link-card{display:flex;align-items:center;gap:14px;padding:18px 20px;background:var(--card-bg);border:1px solid var(--line);border-radius:24px;text-decoration:none;color:var(--text);transition:all .2s;box-shadow:0 8px 30px rgba(61,36,15,.04)}
  .link-card:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 12px 40px rgba(61,36,15,.08)}
  .link-icon{font-size:28px;flex-shrink:0}
  .link-info{flex:1}
  .link-title{font-size:14px;font-weight:700;color:var(--text)}
  .link-desc{font-size:11px;color:var(--muted);margin-top:2px}
  .link-arrow{font-size:18px;color:var(--accent);font-weight:700}
  footer{margin-top:32px;padding-top:22px;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted);display:flex;justify-content:space-between;animation:fadeUp .5s ease .5s both}
  footer a{color:var(--muted);text-decoration:none}
  footer a:hover{color:var(--accent)}
  @keyframes fadeDown{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:translateY(0)}}
  @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
  @media(max-width:700px){.container{padding:36px 18px 60px}.summary-card,.news-card{padding:20px 18px}.pico-grid{grid-template-columns:1fr}.topic-name{width:70px;font-size:11px}footer{flex-direction:column;gap:6px;text-align:center}.links-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">\uD83E\uDD31</div>
    <div class="header-text">
      <h1>PPD Research Daily &middot; 產後憂鬱症研究文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">\uD83D\uDCC5 ${esc(dateDisplay)}</span>
        <span class="badge badge-count">\uD83D\uDCCA ${totalCount} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>\uD83D\uDCCB 今日文獻趨勢</h2>
    <p class="summary-text">${summary}</p>
  </div>

  ${topPicksHtml ? `<div class="section"><div class="section-title"><span class="section-icon">\u2B50</span>今日精選 TOP Picks</div>${topPicksHtml}</div>` : ''}

  ${allPapersHtml ? `<div class="section"><div class="section-title"><span class="section-icon">\uD83D\uDCDA</span>其他值得關注的文獻</div>${allPapersHtml}</div>` : ''}

  ${topicBarsHtml ? `<div class="topic-section section"><div class="section-title"><span class="section-icon">\uD83D\uDCCA</span>主題分佈</div>${topicBarsHtml}</div>` : ''}

  ${keywordsHtml ? `<div class="keywords-section section"><div class="section-title"><span class="section-icon">\uD83C\uDFF7\uFE0F</span>關鍵字</div><div class="keywords">${keywordsHtml}</div></div>` : ''}

  <div class="links-banner">
    <div class="links-grid">
      <a href="https://www.leepsyclinic.com/" class="link-card" target="_blank" rel="noopener">
        <span class="link-icon">\uD83C\uDFE5</span>
        <span class="link-info">
          <span class="link-title">李政洋身心診所</span>
          <span class="link-desc">診所首頁</span>
        </span>
        <span class="link-arrow">&rarr;</span>
      </a>
      <a href="https://blog.leepsyclinic.com/" class="link-card" target="_blank" rel="noopener">
        <span class="link-icon">\uD83D\uDCF0</span>
        <span class="link-info">
          <span class="link-title">訂閱電子報</span>
          <span class="link-desc">最新衛教資訊</span>
        </span>
        <span class="link-arrow">&rarr;</span>
      </a>
      <a href="https://buymeacoffee.com/CYlee" class="link-card" target="_blank" rel="noopener">
        <span class="link-icon">\u2615</span>
        <span class="link-info">
          <span class="link-title">Buy Me a Coffee</span>
          <span class="link-desc">支持本研究計畫</span>
        </span>
        <span class="link-arrow">&rarr;</span>
      </a>
    </div>
  </div>

  <footer>
    <span>資料來源：PubMed &middot; 分析模型：${esc(modelUsed)}</span>
    <span><a href="https://github.com/u8901006/postpartum-depression">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

async function main() {
  const opts = parseArgs();

  if (!opts.apiKey) {
    console.error('[ERROR] No API key. Set ZHIPU_API_KEY env var or use --api-key');
    process.exit(1);
  }

  const dateStr = opts.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const dedupPath = resolve(__dirname, '..', 'docs', 'dedup_state.json');

  let papersData;
  try {
    papersData = JSON.parse(readFileSync(opts.input, 'utf-8'));
  } catch (err) {
    console.error(`[ERROR] Cannot read input: ${err.message}`);
    process.exit(1);
  }

  let state = loadDedupState(dedupPath);
  state = pruneOldEntries(state, 7);

  const allPapers = papersData.papers || [];
  const newPapers = filterNewPapers(allPapers, state);

  console.error(`[INFO] Total fetched: ${allPapers.length}, Already summarized: ${allPapers.length - newPapers.length}, New: ${newPapers.length}`);

  if (newPapers.length === 0) {
    console.error('[INFO] No new papers to summarize');
    const analysis = {
      date: dateStr,
      market_summary: '今日 PubMed 暫無新的產後憂鬱症相關文獻。過去 7 天的文獻均已彙整完畢，請明天再查看。',
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
      _model: 'N/A',
    };
    const html = generateHtml(analysis, 'N/A');
    mkdirSync(dirname(opts.output), { recursive: true });
    writeFileSync(opts.output, html, 'utf-8');
    console.error(`[INFO] Empty report saved to ${opts.output}`);
    return;
  }

  const newPapersData = { date: dateStr, count: newPapers.length, papers: newPapers };
  const analysis = await analyzePapers(opts.apiKey, newPapersData, dateStr);

  if (!analysis) {
    console.error('[ERROR] All AI models failed');
    process.exit(1);
  }

  const modelUsed = analysis._model || MODEL_CHAIN[0];
  const html = generateHtml(analysis, modelUsed);

  mkdirSync(dirname(opts.output), { recursive: true });
  writeFileSync(opts.output, html, 'utf-8');
  console.error(`[INFO] Report saved to ${opts.output}`);

  for (const paper of newPapers) {
    state.summarized_pmids[paper.pmid] = dateStr;
  }
  state.last_updated = dateStr;
  mkdirSync(dirname(dedupPath), { recursive: true });
  writeFileSync(dedupPath, JSON.stringify(state, null, 2), 'utf-8');
  console.error(`[INFO] Dedup state updated: ${newPapers.length} new PMIDs added`);
}

main().catch((err) => {
  console.error(`[ERROR] ${err.message}`);
  process.exit(1);
});

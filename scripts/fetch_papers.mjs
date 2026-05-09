#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_FETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

const BASE_PPD =
  '("Depression, Postpartum"[Mesh] OR ' +
  '((postpartum[tiab] OR postnatal[tiab] OR perinatal[tiab] OR peripartum[tiab] OR puerperal[tiab]) ' +
  'AND (depress*[tiab] OR "mood disorder*"[tiab] OR affective[tiab])) OR ' +
  '"maternal depression"[tiab] OR "paternal postnatal depression"[tiab])';

const TOPIC_QUERIES = [
  BASE_PPD,
  BASE_PPD + ' AND (screening[tiab] OR EPDS[tiab] OR PHQ-9[tiab] OR validation[tiab])',
  BASE_PPD + ' AND (CBT[tiab] OR psychotherapy[tiab] OR IPT[tiab] OR mindfulness[tiab] OR "peer support"[tiab])',
  BASE_PPD + ' AND (antidepressant*[tiab] OR SSRI[tiab] OR sertraline[tiab] OR brexanolone[tiab] OR zuranolone[tiab] OR neurosteroid*[tiab])',
  BASE_PPD + ' AND (cortisol[tiab] OR oxytocin[tiab] OR allopregnanolone[tiab] OR inflammation[tiab] OR cytokine*[tiab] OR fMRI[tiab] OR epigenetic*[tiab] OR microbiome[tiab])',
  BASE_PPD + ' AND (nutrition[tiab] OR "omega-3"[tiab] OR "vitamin D"[tiab] OR DHA[tiab] OR breastfeeding[tiab] OR "sleep deprivation"[tiab])',
  BASE_PPD + ' AND (infant[tiab] OR attachment[tiab] OR bonding[tiab] OR "mother-infant"[tiab] OR neurodevelopment[tiab] OR "paternal depression"[tiab])',
  BASE_PPD + ' AND ("social support"[tiab] OR "intimate partner violence"[tiab] OR poverty[tiab] OR migration[tiab] OR stigma[tiab] OR "health equity"[tiab])',
];

function buildQuery(days) {
  const now = new Date();
  const from = new Date(now.getTime() - days * 86400000);
  const fromStr = from.toISOString().slice(0, 10).replace(/-/g, '/');
  return `("${fromStr}"[dp] : "3000"[dp])`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, opts = {}, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const resp = await fetch(url, opts);
    if (resp.status === 429) {
      const wait = (attempt + 1) * 5000;
      console.error(`[WARN] Rate limited (429), waiting ${wait / 1000}s (attempt ${attempt + 1})...`);
      await sleep(wait);
      continue;
    }
    return resp;
  }
  throw new Error('Max retries exceeded for rate limit');
}

async function searchPapers(query, retmax = 50) {
  const url = new URL(PUBMED_SEARCH);
  url.searchParams.set('db', 'pubmed');
  url.searchParams.set('term', query);
  url.searchParams.set('retmax', String(retmax));
  url.searchParams.set('sort', 'date');
  url.searchParams.set('retmode', 'json');

  const resp = await fetchWithRetry(url.toString(), {
    headers: { 'User-Agent': 'PPDResearchBot/1.0 (research aggregator)' },
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    throw new Error(`PubMed search HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return data.esearchresult?.idlist || [];
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];

  const batchSize = 20;
  const allPapers = [];

  for (let i = 0; i < pmids.length; i += batchSize) {
    const batch = pmids.slice(i, i + batchSize);
    console.error(`[INFO] Fetching batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(pmids.length / batchSize)} (${batch.length} PMIDs)...`);

    const url = new URL(PUBMED_FETCH);
    url.searchParams.set('db', 'pubmed');
    url.searchParams.set('id', batch.join(','));
    url.searchParams.set('retmode', 'xml');

    const resp = await fetchWithRetry(url.toString(), {
      headers: { 'User-Agent': 'PPDResearchBot/1.0 (research aggregator)' },
      signal: AbortSignal.timeout(60000),
    });

    if (!resp.ok) {
      console.error(`[WARN] Fetch batch failed: HTTP ${resp.status}`);
      continue;
    }
    const xml = await resp.text();

    const { XMLParser } = await import('fast-xml-parser');
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '$',
      textNodeName: '#text',
      isArray: (tag) => ['PubmedArticle', 'AbstractText', 'Keyword', 'KeywordList'].includes(tag),
    });

    const result = parser.parse(xml);
    const articles = result.PubmedArticleSet?.PubmedArticle || [];
    const list = Array.isArray(articles) ? articles : [articles];

    for (const article of list) {
      const medline = article.MedlineCitation || {};
      const art = medline.Article || {};

      const rawTitle = art.ArticleTitle;
      const title = typeof rawTitle === 'string' ? rawTitle : rawTitle?.['#text'] || '';

      const abstractParts = [];
      const abstracts = art.Abstract?.AbstractText || [];
      for (const abs of abstracts) {
        if (typeof abs === 'string') {
          if (abs) abstractParts.push(abs);
          continue;
        }
        const label = abs.$Label || '';
        const text = abs['#text'] || '';
        if (label && text) abstractParts.push(`${label}: ${text}`);
        else if (text) abstractParts.push(text);
      }

      const journal = art.Journal?.Title || '';

      const pubDate = art.Journal?.JournalIssue?.PubDate || {};
      const dateParts = [pubDate.Year, pubDate.Month, pubDate.Day].filter(Boolean);

      const rawPmid = medline.PMID;
      const pmid = typeof rawPmid === 'string' ? rawPmid : rawPmid?.['#text'] || '';
      const link = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '';

      const keywords = [];
      const kwLists = medline.KeywordList || [];
      for (const kl of kwLists) {
        const kws = kl.Keyword;
        if (!kws) continue;
        const items = Array.isArray(kws) ? kws : [kws];
        for (const k of items) {
          const t = typeof k === 'string' ? k : k?.['#text'] || '';
          if (t) keywords.push(t.trim());
        }
      }

      allPapers.push({
        pmid: String(pmid),
        title,
        journal,
        date: dateParts.join(' '),
        abstract: abstractParts.join(' ').slice(0, 2000),
        url: link,
        keywords: keywords.slice(0, 20),
      });
    }

    if (i + batchSize < pmids.length) {
      await sleep(2000);
    }
  }

  return allPapers;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 50, output: 'papers.json' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[++i], 10);
    if (args[i] === '--max-papers' && args[i + 1]) opts.maxPapers = parseInt(args[++i], 10);
    if (args[i] === '--output' && args[i + 1]) opts.output = args[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const dateFilter = buildQuery(opts.days);

  const allPmids = new Set();
  for (let idx = 0; idx < TOPIC_QUERIES.length; idx++) {
    const topicQ = TOPIC_QUERIES[idx];
    const query = `${topicQ} AND ${dateFilter}`;
    try {
      const ids = await searchPapers(query, opts.maxPapers);
      for (const id of ids) allPmids.add(id);
    } catch (err) {
      console.error(`[WARN] Topic search ${idx + 1} failed: ${err.message}`);
    }
    if (idx < TOPIC_QUERIES.length - 1) await sleep(1500);
  }

  const pmids = [...allPmids];
  console.error(`[INFO] Found ${pmids.length} unique papers across all topic queries`);

  if (!pmids.length) {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    const empty = { date: today, count: 0, papers: [] };
    writeFileSync(opts.output, JSON.stringify(empty, null, 2), 'utf-8');
    console.error('[INFO] No papers found, saved empty result');
    return;
  }

  const papers = await fetchDetails(pmids);
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const result = { date: today, count: papers.length, papers };
  writeFileSync(opts.output, JSON.stringify(result, null, 2), 'utf-8');
  console.error(`[INFO] Saved to ${opts.output}`);
}

main().catch((err) => {
  console.error(`[ERROR] ${err.message}`);
  process.exit(1);
});

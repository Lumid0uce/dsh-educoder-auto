// 渲染「袁隆平人生轨迹图」PNG（本地 SVG 渲染，中文清晰，不依赖生图模型）
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const EVENTS = [
  { year: '1930', text: ['出生于北京', ''] },
  { year: '1949', text: ['考入西南农学院', '农学系'] },
  { year: '1953', text: ['赴湖南安江农校', '任教'] },
  { year: '1960', text: ['亲历困难时期', '立志解决吃饭问题'] },
  { year: '1964', text: ['发现天然', '雄性不育株'] },
  { year: '1970', text: ['海南发现“野败”', '打开突破口'] },
  { year: '1973', text: ['籼型杂交水稻', '三系配套成功'] },
  { year: '1976', text: ['杂交水稻', '全国大面积推广'] },
  { year: '1981', text: ['获国家', '特等发明奖'] },
  { year: '1995', text: ['当选中国', '工程院院士'] },
  { year: '2001', text: ['获国家最高', '科学技术奖'] },
  { year: '2019', text: ['获“共和国勋章”', ''] },
  { year: '2021', text: ['逝世于长沙', '享年91岁'] },
];

const W = 2320;
const H = 1280;
const AXIS_Y = H / 2 + 10;
const MARGIN = 150;
const GAP = (W - MARGIN * 2) / (EVENTS.length - 1);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const parts = [];
parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
// 标题
parts.push(`<text x="${W / 2}" y="120" text-anchor="middle" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="76" font-weight="700" fill="#111827">袁隆平人生轨迹图（1930—2021）</text>`);
parts.push(`<text x="${W / 2}" y="188" text-anchor="middle" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="36" fill="#6b7280">中国工程院院士 · “杂交水稻之父”</text>`);
parts.push(`<line x1="${MARGIN - 80}" y1="240" x2="${W - MARGIN + 80}" y2="240" stroke="#e5e7eb" stroke-width="3"/>`);
// 主轴
parts.push(`<line x1="${MARGIN - 90}" y1="${AXIS_Y}" x2="${W - MARGIN + 90}" y2="${AXIS_Y}" stroke="#0f172a" stroke-width="6"/>`);
parts.push(`<polygon points="${W - MARGIN + 90},${AXIS_Y} ${W - MARGIN + 58},${AXIS_Y - 16} ${W - MARGIN + 58},${AXIS_Y + 16}" fill="#0f172a"/>`);

EVENTS.forEach((ev, i) => {
  const x = MARGIN + i * GAP;
  const up = i % 2 === 0;
  const color = up ? '#0ea5e9' : '#f97316';
  const stemEnd = up ? AXIS_Y - 120 : AXIS_Y + 120;
  const cardY = up ? AXIS_Y - 300 : AXIS_Y + 130;
  parts.push(`<line x1="${x}" y1="${AXIS_Y}" x2="${x}" y2="${stemEnd}" stroke="${color}" stroke-width="4"/>`);
  parts.push(`<circle cx="${x}" cy="${AXIS_Y}" r="14" fill="#ffffff" stroke="${color}" stroke-width="6"/>`);
  parts.push(`<rect x="${x - 105}" y="${cardY}" width="210" height="176" rx="16" fill="${up ? '#f0f9ff' : '#fff7ed'}" stroke="${color}" stroke-width="3"/>`);
  parts.push(`<text x="${x}" y="${cardY + 58}" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="46" font-weight="700" fill="${color}">${ev.year}</text>`);
  ev.text.forEach((line, k) => {
    if (!line) return;
    parts.push(`<text x="${x}" y="${cardY + 112 + k * 42}" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="30" fill="#1f2937">${esc(line)}</text>`);
  });
});

parts.push(`<text x="${W / 2}" y="${H - 60}" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="30" fill="#9ca3af">一粒种子改变世界 —— 把论文写在稻田里</text>`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
const out = process.argv[2] || 'tmp-timeline.png';

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await page.setContent(`<html><body style="margin:0;background:#fff">${svg}</body></html>`);
await page.screenshot({ path: out, type: 'png' });
await browser.close();

const size = fs.statSync(out).size;
console.log(`已渲染 ${out}（${(size / 1024).toFixed(0)} KB）`);

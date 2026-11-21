/**
 * 学习通（超星）考试通道。
 *
 * 与作业通道（chaoxing-solver.mjs → chaoxing-api.mjs 的 HTTP 抓页）不同，考试有一道
 * 「滑块验证码 + examcheck 签名」闸门：HTTP 直连 `examcheck` 会返回
 * `{"msg":"安全验证不通过，请重新验证","type":"captchaVerify"}`，所以这里全程走浏览器：
 *
 *   须知页 → 勾同意 → enterExam() → 滑块拼图（IoU 缺口匹配 + 合成 MouseEvent）
 *   → reVersionTestStartNew 试卷页 → 读题 → AI 作答 → UEditor 写入
 *   → 页面内 fetch 临时保存 → 回读校验 → 正式交卷
 *
 * 现场事实（实测得出，改之前先看）：
 * - 拼图块容器只有 class `.cx_imgBtn`（没有 id），必须 `bg.querySelector('.cx_imgBtn img')`。
 * - `#eject` 是 position:fixed，offsetParent 恒为 null，可见性只能用
 *   getBoundingClientRect + display 判断。
 * - 只有**合成 MouseEvent** 能拖动滑块；PointerEvent 序列完全无效；真实 page.mouse
 *   拖一次就会被判错并复位。
 * - 控件满足 `left ≈ 发送距离 - 7`；成功判据是 `#captchavalidate` 有值，
 *   或 URL 变成 reVersionTestStartNew。
 * - 判错后滑块复位且**不换图**，必须点 `.cx_refresh` 换新图再试。
 * - 试卷主观题用 UEditor：实例键就是 textarea 的 name（`answer<qid>`），
 *   取实例用 `UE.getEditor('answer'+qid)`，写完必须 `ed.sync()` 才会落到 textarea。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import * as api from './chaoxing-api.mjs';
import * as ai from './chaoxing-ai.mjs';
import * as sessionStore from './chaoxing-session.mjs';
import { solve as solveWithModel } from './ai.mjs';
import { openBrowser, goto, screenshot } from './browser.mjs';
import { createTrace } from './chaoxing-solver.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, Number(ms) || 0));

function firstLine(msg) {
  return String(msg || '').split('\n')[0].slice(0, 300);
}

/** 中文字数（按汉字 + 英文单词粗算，够用于字数门槛判断）。 */
export function cjkCount(text) {
  const s = String(text || '').replace(/<[^>]+>/g, ' ');
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = (s.match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
  return cjk + words;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 纯文本 → UEditor 能吃的简易 HTML。已经是 HTML 的原样返回。 */
export function toEditorHtml(text) {
  const s = String(text == null ? '' : text);
  if (/<(p|br|div|h[1-6]|ul|ol|li)\b/i.test(s)) return s;
  const paras = s.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paras.map((p) => `<p>${esc(p).replace(/\n/g, '<br/>')}</p>`).join('');
}

/* ------------------------------------------------------------------ */
/* 页面内函数（会被 String(fn) 序列化后丢进浏览器执行，禁止引用模块作用域） */
/* ------------------------------------------------------------------ */

/** 勾「我已阅读并同意」+ 触发进入考试。 */
function pageEnter() {
  const out = { agree: false, btn: false, via: null, hasCaptcha: null };
  const agree =
    document.querySelector('.face_agreement .agree_check') ||
    document.querySelector('.agree_check') ||
    document.querySelector('#agreeCheck');
  if (agree && !/agree_checked/.test(agree.className || '')) {
    agree.classList.add('agree_checked');
    out.agree = true;
  }
  const cb = document.querySelector('#examagree, input[name="examagree"], input[name="agree"]');
  if (cb && cb.type === 'checkbox' && !cb.checked) {
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    out.agree = true;
  }
  const btn = document.querySelector('#startBtn');
  if (btn) {
    btn.classList.remove('opa40');
    btn.classList.remove('disble_time_btn');
    out.btn = true;
  }
  try {
    if (typeof enterExam === 'function') {
      enterExam();
      out.via = 'enterExam';
    } else if (typeof jumpExam === 'function') {
      jumpExam(false, '');
      out.via = 'jumpExam';
    } else if (btn && btn.getAttribute('data')) {
      location.href = btn.getAttribute('data');
      out.via = 'href';
    } else if (btn) {
      btn.click();
      out.via = 'click';
    }
  } catch (err) {
    out.err = String((err && err.message) || err).slice(0, 200);
  }
  out.hasCaptcha = !!document.querySelector('#eject');
  out.url = location.href.slice(0, 200);
  return out;
}

/** 读当前状态：是否已进场 / 验证码是否就绪 / validate 值。 */
function pageState() {
  const eject = document.querySelector('#eject');
  const bg = document.querySelector('#cx_imgBg');
  const btn = document.querySelector('.cx_rightBtn');
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && st.display !== 'none' && st.visibility !== 'hidden';
  };
  return {
    url: location.href,
    entered: !!document.querySelector('#submitTest') || /reVersionTestStartNew/i.test(location.href),
    hasForm: !!document.querySelector('#submitTest'),
    captchaReady: vis(eject) && vis(bg) && vis(btn),
    validate: (document.querySelector('#captchavalidate') || {}).value || '',
    title: (document.title || '').slice(0, 80),
  };
}

/**
 * 拼图滑块：IoU 形状匹配找缺口，再用合成 MouseEvent 拖动。
 * 参数 dist 为 null 时只测量不动手。
 */
function pageCaptcha(dist) {
  return (async () => {
    const sleepLocal = (ms) => new Promise((r) => setTimeout(r, ms));
    const bg = document.querySelector('#cx_imgBg');
    if (!bg) return { err: 'no_bg' };
    const bgUrl = (/url\("?([^")]+)"?\)/.exec(getComputedStyle(bg).backgroundImage) || [])[1];
    const pieceEl = bg.querySelector('.cx_imgBtn img') || bg.querySelector('img');
    if (!bgUrl || !pieceEl) return { err: 'no_images', bgUrl: String(bgUrl).slice(0, 80) };

    const grab = async (u) => {
      const r = await fetch(u, { mode: 'cors', credentials: 'omit' });
      const objUrl = URL.createObjectURL(await r.blob());
      const im = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('img decode failed'));
        i.src = objUrl;
      });
      const c = document.createElement('canvas');
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(im, 0, 0);
      return { d: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
    };

    const BG = await grab(bgUrl);
    const PC = await grab(pieceEl.src);
    const W = BG.w;
    const H = BG.h;
    const dd = BG.d;

    // 缺口掩码：低饱和（接近纯灰）区域。阈值放宽到 mx-mn<=18 就能同时覆盖深灰/浅灰。
    const hole = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < dd.length; i += 4, j++) {
      const R = dd[i];
      const G = dd[i + 1];
      const B2 = dd[i + 2];
      const mx = Math.max(R, G, B2);
      const mn = Math.min(R, G, B2);
      if (mx - mn <= 18 && mn >= 18) hole[j] = 1;
    }

    let px0 = 1e9;
    let px1 = -1;
    let py0 = 1e9;
    let py1 = -1;
    for (let y = 0; y < PC.h; y++) {
      for (let x = 0; x < PC.w; x++) {
        if (PC.d[(y * PC.w + x) * 4 + 3] > 60) {
          if (x < px0) px0 = x;
          if (x > px1) px1 = x;
          if (y < py0) py0 = y;
          if (y > py1) py1 = y;
        }
      }
    }
    if (px1 < 0) return { err: 'empty_piece' };
    const pw = px1 - px0 + 1;
    const ph = py1 - py0 + 1;
    const pmem = new Uint8Array(pw * ph);
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const i = ((y + py0) * PC.w + (x + px0)) * 4;
        if (PC.d[i + 3] > 60) pmem[y * pw + x] = 1;
      }
    }

    const iou = (dx, dy, step) => {
      if (dx < 0 || dy < 0 || dx + pw > W || dy + ph > H) return -1;
      let inter = 0;
      let uni = 0;
      for (let y = 0; y < ph; y += step) {
        for (let x = 0; x < pw; x += step) {
          const a = pmem[y * pw + x];
          const b = hole[(y + dy) * W + (x + dx)];
          if (a && b) inter++;
          if (a || b) uni++;
        }
      }
      return uni ? inter / uni : -1;
    };

    let best = { v: -1, dx: 0, dy: 0 };
    for (let dx = 0; dx + pw <= W; dx += 3) {
      for (let dy = -70; dy <= 70; dy += 3) {
        const v = iou(dx, dy, 2);
        if (v > best.v) best = { v, dx, dy };
      }
    }
    const bx = best.dx;
    const by = best.dy;
    for (let dx = Math.max(0, bx - 6); dx <= Math.min(W - pw, bx + 6); dx++) {
      for (let dy = Math.max(0, by - 6); dy <= by + 6; dy++) {
        const v = iou(dx, dy, 1);
        if (v > best.v) best = { v, dx, dy };
      }
    }

    const holder = bg.querySelector('.cx_imgBtn') || pieceEl.parentElement;
    const preL = parseFloat((holder && holder.style.left) || '0') || 0;
    const shape = { iou: +best.v.toFixed(3), target: best.dx, dy: best.dy, piece: { x0: px0, y0: py0, w: pw, h: ph }, preL, hash: String(bgUrl).slice(-42, -8) };

    if (dist == null) return shape;

    const handle = document.querySelector('.cx_rightBtn') || holder;
    if (!handle) return { ...shape, err: 'no_handle' };
    const r = handle.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    const mk = (t, x, y) =>
      new MouseEvent(t, {
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: t === 'mouseup' ? 0 : 1,
      });

    handle.dispatchEvent(mk('mousedown', sx, sy));
    const N = 32;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const e = t < 0.4 ? t * 1.25 : 0.5 + (t - 0.4) * 0.833; // 先快后慢
      const x = sx + dist * e;
      const y = sy + ((i % 3) - 1);
      document.dispatchEvent(mk('mousemove', x, y));
      window.dispatchEvent(mk('mousemove', x, y));
      await sleepLocal(12 + (i % 6) * 7);
    }
    for (let k = 0; k < 3; k++) {
      document.dispatchEvent(mk('mousemove', sx + dist, sy));
      window.dispatchEvent(mk('mousemove', sx + dist, sy));
      await sleepLocal(70);
    }
    const midL = parseFloat((holder && holder.style.left) || '0') || 0;
    await sleepLocal(250);
    document.dispatchEvent(mk('mouseup', sx + dist, sy));
    await sleepLocal(2400);
    return {
      ...shape,
      sent: dist,
      midL,
      validate: ((document.querySelector('#captchavalidate') || {}).value || '').slice(0, 90),
      url: location.href.slice(0, 200),
      entered: !!document.querySelector('#submitTest') || /reVersionTestStartNew/i.test(location.href),
    };
  })();
}

/** 换一张验证码图（失败一次后必须换，否则同一张永远判错）。 */
function pageRefreshCaptcha() {
  const el = document.querySelector('.cx_refresh');
  if (el) {
    el.click();
    return true;
  }
  return false;
}

/** 读试卷结构。 */
function pageReadPaper() {
  // 注意：这个函数会被 String(fn) 序列化后丢进页面执行，**不能引用模块作用域**
  // （api / ai / sessionStore 在页面里都是 undefined）。需要的东西一律内联。
  const TYPE_NAMES = {
    0: '单选题', 1: '多选题', 2: '填空题', 3: '判断题', 4: '简答题',
    5: '名词解释', 6: '论述题', 7: '计算题', 8: '连线题', 9: '排序题',
    10: '阅读理解', 11: '完形填空', 12: '其他',
  };
  const kindOf = (t) =>
    ({ 0: 'single', 1: 'multiple', 2: 'blank', 3: 'judge', 4: 'text', 5: 'text', 6: 'text', 7: 'text' }[String(t)] || null);

  const form = document.querySelector('#submitTest');
  if (!form) return { err: 'no_form' };
  const textOf = (el) => String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  const val = (name) => {
    const el = form.querySelector(`input[name="${name}"]`) || document.querySelector(`input[name="${name}"]`);
    return el ? String(el.value || '') : '';
  };

  const qids = [...form.querySelectorAll('input[name="questionId"]')].map((e) => String(e.value));
  const questions = qids.map((qid, index) => {
    const type = val(`type${qid}`);
    const score = Number(val(`score${qid}`) || val(`questionScore${qid}`) || 0) || 0;
    const typeName = val(`typeName${qid}`) || TYPE_NAMES[type] || '';

    // 容器：从题型隐藏域往上爬，第一个同时含「作答控件」的祖先就是题目块。
    const marker = form.querySelector(`input[name="type${qid}"]`) || form.querySelector(`input[name="score${qid}"]`);
    let container = null;
    if (marker) {
      let node = marker.parentElement;
      for (let i = 0; i < 12 && node && node !== form; i++, node = node.parentElement) {
        if (
          node.querySelector(`textarea[name^="answerEditor${qid}"]`) ||
          node.querySelector(`textarea[name="answer${qid}"]`) ||
          node.querySelector(`input[name="answer${qid}"]`) ||
          node.querySelector(`[id="answer${qid}"]`)
        ) {
          container = node;
          break;
        }
      }
    }
    if (!container) container = marker ? marker.closest('.questionLi, .TiMu, .mark_item, li, div') || form : form;

    // 题干：多候选取最长（超星把真正题面藏在 .mark_name / .mark_table 里，
    // 而编辑器工具栏的「段落格式 字体 字号 最少1200字」也会命中 [class*=stem]，不能只取第一个命中）
    const NOISE = /^(段落格式|字体|字号|工具栏|下一步|上一步|标记|取消标记|保存|提交|交卷|字数|格式|最少\s*\d+\s*字|最多\s*\d+\s*字)/;
    const cleanText = (raw) =>
      String(raw || '')
        .split(/\r?\n+/)
        .map((s) => s.trim())
        .filter((s) => s && !NOISE.test(s))
        .join('\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
    // 题目块：从作答容器往上抬到整题块（超星把题面放左栏 .splitS-left、编辑器放右栏 .splitS-right，
    // 只沿着作答控件往上爬会停在右栏，题面永远读不到）
    const stemScope =
      (container && container.closest && container.closest('.questionLi, .noSplitBx, .mark_item')) || container || document;
    const stemCands = [];
    const scope = stemScope;
    for (const sel of ['.mark_name', '.mark_table', '.noSplitBx', '.Zy_TItle', '.questionStem', '.stem', '.timu', '.marking_content']) {
      for (const el of scope.querySelectorAll(sel)) {
        const t = cleanText(el.innerText || el.textContent);
        if (t.length >= 6) stemCands.push(t);
      }
    }
    const contText = cleanText(stemScope ? stemScope.innerText : '');
    if (contText.length >= 6) stemCands.push(contText);
    stemCands.sort((a, b) => b.length - a.length);
    let stem = stemCands[0] || '';
    // 选择题这类题目正文在 .Zy_TItle 时上面的最长候选可能是整块容器，回退到较短的题干更干净
    if (kindOf(type) === 'single' || kindOf(type) === 'multiple' || kindOf(type) === 'judge') {
      const short = stemCands.filter((t) => t.length <= 400).sort((a, b) => b.length - a.length)[0];
      if (short) stem = short;
    }
    // 考试标题里的任务描述（如「撰写生涯发展报告」）在题面里往往不重复，补在最前面
    const subject = cleanText((document.querySelector('h2.h2_subject') || {}).innerText || '');
    if (subject) {
      const tail = subject.split('|').pop().trim();
      if (tail && tail.length >= 4 && !stem.includes(tail)) stem = `${tail}\n${stem}`;
    }

    const kind = kindOf(type) || (type === '3' ? 'judge' : 'text');

    const options = [];
    for (const inp of container.querySelectorAll(`input[name="answer${qid}"], input[name="answer${qid}[]"]`)) {
      if (!/^(radio|checkbox)$/i.test(inp.type)) continue;
      const labelEl = inp.closest('label') || inp.parentElement;
      options.push({ value: String(inp.value || ''), label: textOf(labelEl).slice(0, 200) });
    }

    const blanks = [];
    for (const ta of container.querySelectorAll(`textarea[name^="answerEditor${qid}"], input[name^="answerEditor${qid}"]`)) {
      blanks.push({ name: ta.name, value: String(ta.value || '') });
    }

    const textarea = container.querySelector(`textarea[name="answer${qid}"]`) || document.querySelector(`#answer${qid}`);
    const wordMin = textarea ? Number(textarea.getAttribute('wordminnum') || 0) || 0 : 0;
    const wordMax = textarea ? Number(textarea.getAttribute('wordmaxnum') || 0) || 0 : 0;

    return {
      index: index + 1,
      questionId: qid,
      type,
      typeName,
      kind,
      score,
      stem: stem.slice(0, 1500),
      options,
      blanks,
      wordMin,
      wordMax,
      answered: textarea ? String(textarea.value || '').trim().length > 0 : false,
    };
  });

  return {
    url: location.href,
    title: (document.title || '').slice(0, 80),
    action: form.getAttribute('action') || '',
    saveUrl: ((document.querySelector('#saveUrl') || {}).value || '').trim(),
    remainSec: Number(val('remainTime') || 0) || 0,
    tempSave: val('tempSave'),
    questionCount: qids.length,
    questions,
  };
}

/** 填一道题并回读。item = {qid, kind, answer, text} */
function pageFillOne(item) {
  const form = document.querySelector('#submitTest');
  if (!form) return { qid: item.qid, ok: false, reason: 'no_form' };
  const fire = (el, types) => {
    for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true }));
  };
  const out = { qid: item.qid, kind: item.kind, ok: false, via: null };

  if (item.kind === 'single' || item.kind === 'multiple' || item.kind === 'judge') {
    const inputs = [...form.querySelectorAll(`input[name="answer${item.qid}"], input[name="answer${item.qid}[]"]`)].filter(
      (i) => /^(radio|checkbox)$/i.test(i.type)
    );
    if (!inputs.length) return { ...out, reason: 'no_choice_inputs' };
    const raw = Array.isArray(item.answer) ? item.answer : String(item.answer == null ? '' : item.answer).split(/[\s,，、;；|]+/);
    const wanted = new Set(raw.map((s) => String(s).trim().toUpperCase()).filter(Boolean));
    const normJudge = (s) => {
      const t = String(s || '').trim();
      if (/^(对|正确|是|true|T|√|A)$/i.test(t)) return 'TRUE';
      if (/^(错|错误|否|false|F|×|B)$/i.test(t)) return 'FALSE';
      return t.toUpperCase();
    };
    const wantJudge = item.kind === 'judge' ? new Set([...wanted].map(normJudge)) : null;

    let hit = 0;
    for (const inp of inputs) {
      const labelEl = inp.closest('label') || inp.parentElement;
      const labelText = String((labelEl && labelEl.innerText) || '').trim();
      const v = String(inp.value || '').trim().toUpperCase();
      let match = wanted.has(v);
      if (!match && labelText) {
        const head = labelText.slice(0, 1).toUpperCase();
        match = wanted.has(head) || [...wanted].some((w) => labelText.toUpperCase().includes(w));
      }
      if (item.kind === 'judge' && wantJudge) {
        match = wantJudge.has(normJudge(inp.value)) || wantJudge.has(normJudge(labelText));
      }
      if (match) {
        inp.checked = true;
        inp.click();
        fire(inp, ['input', 'change']);
        hit++;
        if (item.kind !== 'multiple') break;
      }
    }
    out.hit = hit;
    out.via = 'choice';
    out.ok = hit > 0 || item.kind === 'multiple';
    out.text = inputs.filter((i) => i.checked).map((i) => i.value).join(',');
    return out;
  }

  if (item.kind === 'blank') {
    const boxes = [
      ...form.querySelectorAll(`textarea[name^="answerEditor${item.qid}"], input[name^="answerEditor${item.qid}"]`),
    ].filter((el) => el.tagName === 'TEXTAREA' || /^(text|search|)$/i.test(el.type || ''));
    if (!boxes.length) return { ...out, reason: 'no_blank_inputs' };
    const list = Array.isArray(item.answer)
      ? item.answer
      : String(item.answer == null ? '' : item.answer).split(/[\n|｜]+|(?<=[；;])/).map((s) => s.trim()).filter(Boolean);
    boxes.forEach((el, i) => {
      const v = String(list[i] == null ? list[0] == null ? '' : list[0] : list[i]);
      el.focus();
      el.value = v;
      fire(el, ['input', 'change', 'blur']);
    });
    out.via = 'blank';
    out.filled = boxes.length;
    out.ok = boxes.some((el) => String(el.value || '').trim().length > 0);
    return out;
  }

  // 主观题（简答/论述/名词解释…）：优先写 UEditor
  const key = 'answer' + item.qid;
  const html = item.html || item.text || '';
  let ed = null;
  try {
    if (window.UE && typeof UE.getEditor === 'function') ed = UE.getEditor(key);
  } catch (e) {
    ed = null;
  }
  if (!ed && window.UE && UE.instants) {
    ed = Object.values(UE.instants).find((e) => e && e.key === key) || null;
  }
  if (ed && typeof ed.setContent === 'function') {
    try {
      ed.setContent(html);
      if (typeof ed.sync === 'function') ed.sync();
      out.via = 'ueditor';
    } catch (e) {
      out.editorErr = String((e && e.message) || e).slice(0, 160);
    }
  }
  const ta = form.querySelector(`textarea[name="${key}"]`) || document.querySelector(`#${key}`);
  if (!out.via && ta) {
    ta.value = html;
    fire(ta, ['input', 'change', 'blur']);
    out.via = 'textarea';
  }
  if (ta) {
    const got = String(ta.value || '').length;
    out.len = got;
    out.ok = got > 0;
    if (!out.ok && ed && typeof ed.getContent === 'function') {
      out.len = cjkCountLen(ed.getContent());
      out.ok = out.len > 0;
    }
  }
  if (out.via === 'ueditor' && ta && String(ta.value || '').length === 0) {
    // sync 没落盘的兜底：直接写入 textarea
    ta.value = html.replace(/<[^>]+>/g, '');
    fire(ta, ['input', 'change']);
    out.via = 'ueditor+textarea';
    out.len = String(ta.value || '').length;
    out.ok = out.len > 0;
  }
  return out;

  function cjkCountLen(s) {
    return String(s || '').replace(/<[^>]+>/g, ' ').trim().length;
  }
}

/** 回读：把每题的当前作答值读出来，用于校验。 */
function pageReadAnswers(qids) {
  const form = document.querySelector('#submitTest');
  if (!form) return { err: 'no_form' };
  const out = {};
  for (const qid of qids) {
    const ta = form.querySelector(`textarea[name="answer${qid}"]`) || document.querySelector(`#answer${qid}`);
    const choice = [...form.querySelectorAll(`input[name="answer${qid}"], input[name="answer${qid}[]"]`)].filter(
      (i) => i.checked
    );
    const blanks = [...form.querySelectorAll(`textarea[name^="answerEditor${qid}"], input[name^="answerEditor${qid}"]`)];
    out[qid] = {
      text: ta ? String(ta.value || '') : '',
      choice: choice.map((i) => i.value),
      blanks: blanks.map((el) => String(el.value || '')),
    };
  }
  return out;
}

/**
 * 保存 / 交卷。samepage = true 时在同一页用 fetch 发（签名、UEditor 由页面自己负责）。
 * tempSave=true 只暂存，false 才是正式交卷。
 */
function pageSave(tempSave) {
  return (async () => {
    const form = document.querySelector('#submitTest');
    if (!form) return { err: 'no_form' };
    // 先把所有 UEditor 同步回 textarea
    try {
      if (window.UE) {
        const list = UE.instants ? Object.values(UE.instants) : [];
        for (const ed of list) {
          try {
            ed && typeof ed.sync === 'function' && ed.sync();
          } catch (e) {
            /* ignore */
          }
        }
      }
    } catch (e) {
      /* ignore */
    }
    const saveUrl = ((document.querySelector('#saveUrl') || {}).value || form.getAttribute('action') || '').trim();
    if (!saveUrl) return { err: 'no_save_url' };
    const base = saveUrl.split('?')[0];
    const keep = saveUrl.includes('?') ? saveUrl.slice(saveUrl.indexOf('?') + 1).replace(/[?&]?(tempSave|version|view)=[^&]*/g, '').replace(/^&+/, '') : '';
    const url = `${base}?${keep ? keep + '&' : ''}tempSave=${tempSave ? 'true' : 'false'}&version=1&view=json`;
    const body = new URLSearchParams(new FormData(form)).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body,
      credentials: 'include',
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = null;
    }
    return { status: res.status, url, json, text: text.slice(0, 600) };
  })();
}

/** trace 兼容层：chaoxing-solver 的 createTrace() 返回 {push,text,lines}，这里统一成函数。 */
function toTracer(trace) {
  if (typeof trace === 'function') return trace;
  if (trace && typeof trace.push === 'function') {
    return (msg, extra) =>
      trace.push(extra === undefined ? String(msg) : `${msg} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`.slice(0, 400));
  }
  return () => {};
}

/* ------------------------------------------------------------------ */
/* 浏览器侧                                                           */
/* ------------------------------------------------------------------ */

/** 把 session.json 里的 cookie 对象灌进一个干净 context。 */
export async function injectCookies(context, cookies) {
  const raw = cookies && typeof cookies === 'object' ? cookies : {};
  const jar = Object.entries(raw)
    .filter(([name, value]) => name && value != null && String(value) !== '')
    .map(([name, value]) => ({ name, value: String(value), domain: '.chaoxing.com', path: '/' }));
  if (!jar.length) return 0;
  await context.addCookies(jar).catch(() => {});
  return jar.length;
}

/**
 * 打开考试用浏览器。优先复用持久化 profile（保留登录态）；profile 损坏时
 * 自动退化到临时 profile + cookie 注入 —— 硬杀浏览器会把 user-data-dir 弄坏，
 * 之后 launchPersistentContext 恒抛 "Target page, context or browser has been closed"。
 */
export async function openExamBrowser(cookies, opts = {}) {
  const headless = opts.headless !== false;
  const timeoutMs = opts.timeoutMs || 60000;
  let fallbackReason = null;
  if (opts.reuseProfile !== false) {
    try {
      const session = await openBrowser({
        profileDir: opts.profileDir || sessionStore.profileDir(),
        headless,
        timeoutMs,
      });
      return { session, profileMode: 'persistent', injected: 0 };
    } catch (err) {
      fallbackReason = firstLine(err && err.message);
    }
  }
  const dir = path.join(os.tmpdir(), `chaoxing-exam-${Date.now()}`);
  const session = await openBrowser({ profileDir: dir, headless, timeoutMs });
  const injected = await injectCookies(session.context, cookies);
  return { session, profileMode: 'temp', injected, fallbackReason };
}

/**
 * 进场：须知页 → 勾同意 → enterExam → 滑块循环。
 * @returns {Promise<{entered:boolean, url:string, captchaRounds:number, manual:boolean, trigger:object}>}
 */
export async function enterExam(session, opts = {}) {
  const page = session.page;
  const trace = toTracer(opts.trace);
  const rounds = Number.isFinite(opts.captchaRounds) ? opts.captchaRounds : 6;
  const examUrl = String(opts.examUrl || '').trim();
  if (!examUrl) throw new Error('enterExam 需要 examUrl');

  await goto(session, examUrl, { timeoutMs: 60000, waitUntil: 'domcontentloaded' });
  await sleep(opts.settleMs == null ? 2600 : opts.settleMs);

  // 持久化 profile 里的登录态可能已经丢了（比如浏览器被硬杀过），页面会跳到 passport2 登录页。
  // 这时把 session.json 的 cookie 灌进去再重开一次；还不行就明确返回 NEED_LOGIN。
  const loginUrl = () => /passport2\.chaoxing\.com\/login/.test(page.url());
  if (loginUrl()) {
    const injected = await injectCookies(session.context, opts.cookies || {});
    trace && trace('exam.enter.cookieInject', { injected, url: page.url() });
    if (injected) {
      await goto(session, examUrl, { timeoutMs: 60000, waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1800);
    }
    if (loginUrl()) {
      return { entered: false, url: page.url(), captchaRounds: 0, manual: false, trigger: { err: 'NEED_LOGIN' }, reason: 'NEED_LOGIN' };
    }
  }

  // 已经交过卷的考试，须知页会直接跳到 /exam/test/look（查看结果页），没有 #startBtn
  const alreadySubmitted = async () => {
    const u = page.url();
    if (/\/exam\/test\/look/.test(u)) return true;
    if (await page.$('#startBtn')) return false;
    const body = await page.evaluate('document.body ? document.body.innerText.slice(0, 4000) : ""').catch(() => '');
    return /已提交|已完成|查看试卷|作答时间耗尽/.test(String(body || ''));
  };
  if (await alreadySubmitted()) {
    trace && trace('exam.enter.alreadySubmitted', { url: page.url() });
    return { entered: false, url: page.url(), captchaRounds: 0, manual: false, trigger: { err: 'ALREADY_SUBMITTED' }, reason: 'ALREADY_SUBMITTED' };
  }

  const trigger = await page.evaluate(`(${pageEnter})()`).catch((err) => ({ err: firstLine(err && err.message) }));
  trace && trace('exam.enter.trigger', trigger);
  await sleep(3800);

  let state = await page.evaluate(`(${pageState})()`);
  if (state.entered) return { entered: true, url: state.url, captchaRounds: 0, manual: false, trigger };

  if (!state.captchaReady) {
    // 有的班把同意框做成真 checkbox，enterExam 里判定不通过时会静默 return，补一次点击
    await page.evaluate(`(${pageEnter})()`).catch(() => {});
    await sleep(3000);
    state = await page.evaluate(`(${pageState})()`);
    if (state.entered) return { entered: true, url: state.url, captchaRounds: 0, manual: false, trigger };
  }

  // 滑块：off 是「发送距离 - 实际 left」的标定量，delta 用来蹭服务端的 1~3px 基准差
  let off = Number.isFinite(opts.offset) ? opts.offset : 7;
  const deltas = Array.isArray(opts.deltas) && opts.deltas.length ? opts.deltas : [0, 3, -2, 1, -1, 4, -4, 2];
  let used = 0;

  for (let i = 0; i < rounds; i++) {
    if (opts.signal && opts.signal.aborted) break;
    const measure = await page
      .evaluate(`(${pageCaptcha})(${JSON.stringify(null)})`)
      .catch((err) => ({ err: firstLine(err && err.message) }));
    trace && trace('exam.captcha.measure', { i, ...measure });
    if (measure && measure.err) {
      await page.evaluate(`(${pageRefreshCaptcha})()`).catch(() => {});
      await sleep(2600);
      continue;
    }
    if (measure.iou < 0.55) {
      await page.evaluate(`(${pageRefreshCaptcha})()`).catch(() => {});
      await sleep(2600);
      continue;
    }
    const delta = deltas[used % deltas.length];
    const want = Math.max(6, Math.round(measure.target - measure.piece.x0 + off + delta));
    used++;
    const res = await page
      .evaluate(`(${pageCaptcha})(${JSON.stringify(want)})`)
      .catch((err) => ({ err: firstLine(err && err.message) }));
    trace && trace('exam.captcha.drag', { i, want, delta, ...res });
    if (res && res.midL > 10 && res.midL < 300) off = Math.round(want - res.midL);
    state = await page.evaluate(`(${pageState})()`);
    if (state.entered) return { entered: true, url: state.url, captchaRounds: i + 1, manual: false, trigger };
    if (state.validate) {
      // validate 有值说明这轮过了，等跳转
      await sleep(2500);
      state = await page.evaluate(`(${pageState})()`);
      if (state.entered) return { entered: true, url: state.url, captchaRounds: i + 1, manual: false, trigger };
    }
    await page.evaluate(`(${pageRefreshCaptcha})()`).catch(() => {});
    await sleep(2600);
  }

  // 自动过不去 → 交给人工（把窗口拎到前台，轮询等页面跳转）
  const manualSec = Number.isFinite(opts.manualTimeoutSec) ? opts.manualTimeoutSec : 0;
  if (manualSec > 0) {
    await page.bringToFront().catch(() => {});
    const deadline = Date.now() + manualSec * 1000;
    while (Date.now() < deadline) {
      if (opts.signal && opts.signal.aborted) break;
      await sleep(1500);
      state = await page.evaluate(`(${pageState})()`).catch(() => state);
      if (state && state.entered) {
        return { entered: true, url: state.url, captchaRounds: used, manual: true, trigger };
      }
    }
  }

  return { entered: false, url: state && state.url, captchaRounds: used, manual: false, trigger };
}

/** 读卷（必须在试卷页上调用）。 */
export async function readPaper(session) {
  const paper = await session.page.evaluate(`(${pageReadPaper})()`);
  if (!paper || paper.err) throw new Error(`读卷失败：${paper && paper.err}`);
  paper.questions = (paper.questions || []).filter((q) => q.kind);
  return paper;
}

/** 逐题写入答案。answers = {qid: value} */
export async function fillAnswers(session, paper, answers, opts = {}) {
  const page = session.page;
  const gapMs = Number.isFinite(opts.gapMs) ? opts.gapMs : 0;
  const trace = toTracer(opts.trace);
  const filled = [];
  for (const q of paper.questions) {
    if (opts.signal && opts.signal.aborted) break;
    const value = answers[q.questionId];
    const item = {
      qid: q.questionId,
      kind: q.kind,
      answer: q.kind === 'text' ? undefined : value,
      text: q.kind === 'text' ? String(value == null ? '' : value) : undefined,
      html: q.kind === 'text' ? toEditorHtml(value) : undefined,
    };
    const res = await page
      .evaluate(`(${pageFillOne})(${JSON.stringify(item)})`)
      .catch((err) => ({ qid: q.questionId, ok: false, reason: firstLine(err && err.message) }));
    filled.push({ ...res, index: q.index, typeName: q.typeName });
    trace && trace('exam.fill', res);
    if (gapMs > 0) await sleep(gapMs);
  }
  return filled;
}

/** 回读页面上的答案。 */
export async function readAnswers(session, paper) {
  const qids = paper.questions.map((q) => q.questionId);
  return session.page.evaluate(`(${pageReadAnswers})(${JSON.stringify(qids)})`);
}

/** 暂存 / 交卷。 */
export async function savePaper(session, { tempSave = true } = {}) {
  return session.page.evaluate(`(${pageSave})(${JSON.stringify(!!tempSave)})`);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */

/** 试卷里带字数门槛的题目提示，拼进 AI 的额外要求。 */
function paperHints(paper) {
  const lines = [];
  const limits = paper.questions.filter((q) => q.kind === 'text' && (q.wordMin || q.wordMax));
  for (const q of limits) {
    lines.push(
      `第 ${q.index} 题（${q.typeName || '主观题'}，${q.score} 分）字数必须控制在 ${q.wordMin || 0}~${q.wordMax || 0} 字之间。`
    );
  }
  const total = paper.questions.reduce((s, q) => s + (q.score || 0), 0);
  if (total) lines.push(`本卷共 ${paper.questions.length} 题，合计 ${total} 分。`);
  return lines.join('\n');
}

/** 把过短的论述题补写一轮。 */
async function topUpTextAnswers({ paper, answers, llm, aiConfig, extra, signal, trace }) {
  const short = paper.questions.filter(
    (q) => q.kind === 'text' && q.wordMin && cjkCount(answers[q.questionId]) < q.wordMin * 0.85
  );
  if (!short.length) return { answers, redone: [] };
  const brief = short.map((q) => ({
    questionId: q.questionId,
    typeName: q.typeName,
    score: q.score,
    stem: q.stem,
    need: `${q.wordMin}~${q.wordMax || q.wordMin + 300} 字`,
    draft: String(answers[q.questionId] || '').slice(0, 800),
  }));
  const prompt = [
    '下面每道主观题的初稿字数不足，请重写并补足到要求的字数区间，内容必须紧扣题干与评分维度，禁止注水重复。',
    extra ? `额外要求：${extra}` : '',
    '只输出一个 JSON 对象，形如 {"888072124":"正文"}，键必须是 questionId，值是纯文本正文（不要 Markdown 标记、不要代码块）：',
    JSON.stringify(brief, null, 2),
  ]
    .filter(Boolean)
    .join('\n\n');

  const { text } = await solveWithModel({
    llm,
    config: aiConfig || {},
    system: ai.ANSWER_SYSTEM,
    prompt,
    maxTokens: 8000,
    temperature: 0.5,
    signal,
  });
  const parsed = ai.extractJson(text);
  const raw = (parsed && (parsed.answers || parsed)) || {};
  const redone = [];
  for (const q of short) {
    const v = raw[q.questionId];
    if (typeof v === 'string' && cjkCount(v) > cjkCount(answers[q.questionId])) {
      answers[q.questionId] = v;
      redone.push(q.questionId);
    }
  }
  trace && trace('exam.topup', { redone, before: short.length });
  return { answers, redone };
}

/**
 * 一场考试的全流程。
 *
 * @param {object} opts
 * @param {string} opts.examUrl 考试须知页（examnotes）地址
 * @param {object} [opts.cookies] 默认取插件 session
 * @param {object} [opts.llm] 宿主 llm
 * @param {object} [opts.aiConfig] AI 配置
 * @param {boolean} [opts.submit=true] 是否正式交卷
 * @param {boolean} [opts.verify=true] 暂存后回读校验
 * @param {string} [opts.extra] 额外作答要求
 * @param {number} [opts.captchaRounds=6] 滑块最多试几轮
 * @param {number} [opts.manualTimeoutSec=0] 自动过不去时等人工的秒数（0 = 不等）
 * @param {number} [opts.gapMs=0] 每题间隔
 * @param {boolean} [opts.headless] 默认 false（滑块要看得见才容易排查）
 * @param {string} [opts.outDir] 落地 paper.html / exam-result.json 的目录
 */
export async function solveExam(opts = {}) {
  const trace = toTracer(opts.trace || createTrace());
  const startedAt = Date.now();
  const examUrl = String(opts.examUrl || opts.url || '').trim();
  if (!examUrl) throw new Error('solveExam 需要 examUrl（考试须知页地址）');

  const cookies = opts.cookies || (await sessionStore.getCookies());
  const submit = opts.submit !== false;
  const verify = opts.verify !== false;
  const headless = !!opts.headless;

  const { session, profileMode, injected, fallbackReason } = await openExamBrowser(cookies, {
    headless,
    profileDir: opts.profileDir,
    timeoutMs: opts.timeoutMs,
  });
  trace('exam.browser', { profileMode, injected, fallbackReason, headless });

  const result = {
    ok: false,
    stage: 'enter',
    profileMode,
    fallbackReason: fallbackReason || null,
    examUrl,
    captchaRounds: 0,
    manual: false,
    paper: null,
    answers: null,
    filled: [],
    problems: [],
    verify: null,
    save: null,
    final: null,
    elapsedMs: 0,
  };

  try {
    const enter = await enterExam(session, {
      examUrl,
      cookies,
      trace,
      signal: opts.signal,
      captchaRounds: opts.captchaRounds,
      manualTimeoutSec: opts.manualTimeoutSec == null ? 0 : opts.manualTimeoutSec,
      offset: opts.offset,
      deltas: opts.deltas,
    });
    trace('exam.enter', { entered: !!enter.entered, reason: enter.reason || '', rounds: enter.captchaRounds, manual: !!enter.manual, url: enter.url });
    result.entered = !!enter.entered;
    result.captchaRounds = enter.captchaRounds;
    result.manual = !!enter.manual;
    result.enteredUrl = enter.url;
    if (!enter.entered) {
      result.reason =
        enter.reason === 'NEED_LOGIN'
          ? '学习通登录态已失效，先跑 chaoxing_login'
          : enter.reason === 'ALREADY_SUBMITTED'
            ? '这场考试已经交过卷了（须知页跳到了查看结果页），换一场考试再跑'
            : '没能通过验证码进场';
      if (opts.outDir) await screenshot(session, { path: path.join(opts.outDir, 'exam-enter-fail.png') }).catch(() => {});
      return result;
    }

    await sleep(2200);
    const paper = await readPaper(session);
    result.stage = 'answer';
    result.paper = paper;
    if (!paper.questions.length) {
      result.reason = '试卷页没有解析到题目';
      return result;
    }
    if (opts.outDir) {
      try {
        fs.mkdirSync(opts.outDir, { recursive: true });
        fs.writeFileSync(path.join(opts.outDir, 'paper.html'), await session.page.content(), 'utf8');
        fs.writeFileSync(path.join(opts.outDir, 'paper.json'), JSON.stringify(paper, null, 2), 'utf8');
      } catch (e) {
        /* 落地失败不影响作答 */
      }
    }

    const extra = [opts.extra, paperHints(paper)].filter(Boolean).join('\n');
    const prompt = ai.buildAnswerPrompt(paper.questions, extra);
    const { text, route } = await solveWithModel({
      llm: opts.llm,
      config: opts.aiConfig || {},
      system: ai.ANSWER_SYSTEM,
      prompt,
      maxTokens: opts.maxTokens || 16000,
      temperature: opts.temperature == null ? 0.4 : opts.temperature,
      signal: opts.signal,
    });
    result.ai = { route, chars: String(text || '').length };

    const parsed = ai.extractJson(text);
    const normalized = ai.normalizeAll(paper.questions, parsed);
    let answers = normalized.answers;
    result.problems = normalized.problems || [];

    // 选择题合法性闸门：答案里出现非选项字母的，宁可停在这里也不交白卷
    const badChoice = paper.questions.filter((q) => {
      if (!['single', 'multiple', 'judge'].includes(q.kind)) return false;
      const v = String(answers[q.questionId] == null ? '' : answers[q.questionId]).trim();
      if (!v) return true;
      const allowed = new Set(q.options.map((o) => String(o.value).toUpperCase()));
      const letters = q.kind === 'multiple' ? v.toUpperCase().split('') : [v.toUpperCase().replace(/^([A-Z]).*$/, '$1')];
      return letters.some((l) => l && !allowed.has(l));
    });
    if (badChoice.length) {
      result.stage = 'answer';
      result.reason = `选择题答案与选项不匹配：${badChoice.map((q) => `第${q.index}题`).join('、')}`;
      result.answers = answers;
      return result;
    }

    const topped = await topUpTextAnswers({
      paper,
      answers,
      llm: opts.llm,
      aiConfig: opts.aiConfig,
      extra,
      signal: opts.signal,
      trace,
    });
    answers = topped.answers;
    result.answers = answers;

    const filled = await fillAnswers(session, paper, answers, { gapMs: opts.gapMs, signal: opts.signal, trace });
    result.filled = filled;
    result.stage = 'fill';

    if (verify) {
      const saved = await readAnswers(session, paper);
      result.verify = saved;
      const empty = paper.questions.filter((q) => {
        const got = saved[q.questionId] || {};
        if (q.kind === 'text') return String(got.text || '').trim().length < 2;
        if (q.kind === 'blank') return !(got.blanks || []).some((b) => String(b).trim());
        return !(got.choice || []).length;
      });
      if (empty.length) {
        result.problems = [...result.problems, ...empty.map((q) => `第${q.index}题回读为空`)];
      }
    }

    const temp = await savePaper(session, { tempSave: true });
    result.save = temp;
    if (!temp || (!temp.json && !/成功/.test(String(temp.text || '')))) {
      result.stage = 'save';
      result.reason = `暂存失败：${firstLine(temp && (temp.text || temp.err))}`;
      return result;
    }

    result.stage = 'done';
    result.ok = true;

    if (submit) {
      const fin = await savePaper(session, { tempSave: false });
      result.final = fin;
      const okFinal =
        fin && ((fin.json && (fin.json.status === 'success' || /成功/.test(String(fin.json.msg || '')))) || /成功/.test(String(fin.text || '')));
      result.submitted = !!okFinal;
      if (!okFinal) {
        result.stage = 'submit';
        result.reason = `交卷返回异常：${firstLine((fin && (fin.text || fin.err)) || '')}`;
        result.ok = false;
      }
    } else {
      result.submitted = false;
    }

    return result;
  } finally {
    result.elapsedMs = Date.now() - startedAt;
    if (opts.keepOpen !== true) {
      await session.close().catch(() => {});
    }
  }
}

export const __pageFns = {
  pageEnter,
  pageState,
  pageCaptcha,
  pageRefreshCaptcha,
  pageReadPaper,
  pageFillOne,
  pageReadAnswers,
  pageSave,
};

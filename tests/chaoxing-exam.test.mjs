/**
 * 学习通考试通道单测（快测，不起浏览器）：
 *   - 字数统计 / 富文本转换
 *   - 页面内函数的「序列化安全性」回归守卫
 *     （pageReadPaper 曾经在页面里引用模块作用域的 api.TYPE_NAMES，
 *       被 String(fn) 序列化后抛 ReferenceError: api is not defined）
 */

import assert from 'node:assert/strict';
import { cjkCount, toEditorHtml, __pageFns } from '../lib/chaoxing-exam.mjs';

export default async function testChaoxingExam() {
  /* ---------- cjkCount：汉字按字算，英文按词算，标签先剥掉 ---------- */
  assert.equal(cjkCount('生涯发展报告'), 6);
  assert.equal(cjkCount('<p>自我认知</p><p>career plan</p>'), 4 + 2);
  assert.equal(cjkCount(''), 0);
  assert.equal(cjkCount(null), 0);

  /* ---------- toEditorHtml：纯文本包 <p>，已是 HTML 就原样放行 ---------- */
  const plain = toEditorHtml('第一段\n\n第二段');
  assert.equal(plain, '<p>第一段</p><p>第二段</p>');
  assert.equal(toEditorHtml('<h2>一、自我认知</h2><p>正文</p>'), '<h2>一、自我认知</h2><p>正文</p>');
  // 单换行在纯文本里应当保留成 <br/>，别把段落粘死
  assert.equal(toEditorHtml('上\n下'), '<p>上<br/>下</p>');
  // 尖括号要转义，否则用户正文里的 < 会把编辑器结构打穿
  assert.equal(toEditorHtml('a<b'), '<p>a&lt;b</p>');
  assert.equal(toEditorHtml(''), '');
  assert.equal(toEditorHtml(undefined), '');

  /* ---------- 序列化安全：页面内函数不得引用模块作用域 ---------- */
  const FORBIDDEN = /\b(api|ai|sessionStore|chaoxingSession|chaoxingSolver|fs|path)\s*\./;
  const banned = [];
  for (const [name, fn] of Object.entries(__pageFns)) {
    assert.equal(typeof fn, 'function', `__pageFns.${name} 必须是函数`);
    const src = String(fn);
    if (FORBIDDEN.test(src)) banned.push(name);
  }
  assert.deepEqual(banned, [], `这些页面内函数引用了模块作用域，进页面会 ReferenceError：${banned.join(', ')}`);

  /* ---------- pageReadPaper 必须内联题型表（回归守卫） ---------- */
  const readPaperSrc = String(__pageFns.pageReadPaper);
  assert.match(readPaperSrc, /const TYPE_NAMES = \{/, 'pageReadPaper 必须内联 TYPE_NAMES');
  assert.match(readPaperSrc, /const kindOf = /, 'pageReadPaper 必须内联 kindOf');
  assert.doesNotMatch(readPaperSrc, /api\.TYPE_NAMES/, 'pageReadPaper 不得再引用 api.TYPE_NAMES');

  /* ---------- 题干主体范围：必须抬到整题块，不能停在右栏 ---------- */
  assert.match(readPaperSrc, /closest\('\.questionLi, \.noSplitBx, \.mark_item'\)/, 'pageReadPaper 缺少整题块抬升');

  const names = Object.keys(__pageFns).sort();
  assert.ok(names.includes('pageEnter'), '缺少 pageEnter');
  assert.ok(names.includes('pageReadPaper'), '缺少 pageReadPaper');
  assert.ok(names.includes('pageFillOne'), '缺少 pageFillOne');
  assert.ok(names.includes('pageReadAnswers'), '缺少 pageReadAnswers');
  assert.ok(names.includes('pageSave'), '缺少 pageSave');
  assert.ok(names.includes('pageCaptcha'), '缺少 pageCaptcha');

  return `${names.length} 个页面内函数序列化安全、题型表已内联`;
}

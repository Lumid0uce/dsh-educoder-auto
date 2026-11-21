/**
 * 学习通试卷页 DOM 单测（慢测，起一个无头 Edge，但拦掉所有网络请求）：
 *   - pageReadPaper：题干必须取到评分维度表，不能取到编辑器工具栏
 *   - pageFillOne：主观题无 UEditor 时退 textarea
 *   - pageReadAnswers：回读答案
 *
 * 用离线 setContent 复现真卷结构（超星把题面放左栏 .mark_name、编辑器放右栏 .splitS-right）。
 * 跑：`node tests/run.mjs --all`，或单跑 `node tests/chaoxing-exam-dom.test.mjs`
 */

import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { __pageFns } from '../lib/chaoxing-exam.mjs';
import { DEFAULT_EDGE } from '../lib/browser.mjs';

const QID = '888072124';

const FIXTURE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>考试</title></head><body>
<h2 class="h2_subject">结果性考核3 | 第八讲授课教师发布并评阅 | 撰写生涯发展报告</h2>
<form id="submitTest" action="/exam-ans/exam/test/reVersionSubmitTestNew?classId=153830884">
  <input type="hidden" id="saveUrl" value="/exam-ans/exam/test/reVersionSubmitTestNew">
  <input type="hidden" name="remainTime" value="3598">
  <input type="hidden" name="tempSave" value="false">
  <div class="whiteDiv questionLi singleQuesId ans-cc mainhet">
    <div class="type_tit">一、 论述题 （共 1 题，50.0 分）</div>
    <div class="splitS-left">
      <h3 class="mark_name colorDeep">1. (论述题, 50.0 分) 评分维度 评分要点 满分
自我认知与职业目标 1. 自我分析清晰（兴趣、性格、价值观等） 10分
职业世界探索 1. 目标岗位信息完整 10分
成长计划与行动 1. 阶段目标可执行 10分
动态调整与反思 1. 有复盘机制 10分
报告结构与规范性 1. 结构完整，逻辑清晰 10分</h3>
    </div>
    <div class="splitS-right">
      <input type="hidden" name="questionId" value="${QID}">
      <input type="hidden" name="type${QID}" value="6">
      <input type="hidden" name="score${QID}" value="50.0">
      <input type="hidden" name="typeName${QID}" value="论述题">
      <div class="eidtDiv subEditor">
        <div class="edui-toolbar">段落格式 字体 字号 最少1200字,最多2000字 下一步 标记</div>
        <textarea id="answer${QID}" name="answer${QID}" wordminnum="1200" wordmaxnum="2000"></textarea>
      </div>
    </div>
  </div>
</form>
</body></html>`;

async function evaluateFn(page, fn, ...args) {
  const src = String(fn);
  return page.evaluate(`(${src})(${args.map((a) => JSON.stringify(a)).join(', ')})`);
}

export default async function testChaoxingExamDom() {
  const browser = await chromium.launch({ executablePath: DEFAULT_EDGE, headless: true });
  try {
    const page = await browser.newPage();
    // 断网：试卷页会拉 UEditor / 统计脚本，离线单测不需要
    await page.route(/^https?:/, (route) => route.abort());
    await page.setContent(FIXTURE, { waitUntil: 'domcontentloaded' });

    /* ---------- 读卷 ---------- */
    const paper = await evaluateFn(page, __pageFns.pageReadPaper);
    assert.ok(!paper.err, `读卷失败：${paper.err}`);
    assert.equal(paper.questionCount, 1);
    assert.equal(paper.saveUrl, '/exam-ans/exam/test/reVersionSubmitTestNew');
    assert.match(paper.action, /reVersionSubmitTestNew/);
    assert.equal(paper.remainSec, 3598);

    const q = paper.questions[0];
    assert.equal(q.questionId, QID);
    assert.equal(q.type, '6');
    assert.equal(q.kind, 'text');
    assert.equal(q.typeName, '论述题');
    assert.equal(q.score, 50);
    assert.equal(q.wordMin, 1200);
    assert.equal(q.wordMax, 2000);

    // 题干：要拿到评分维度表，且不能是编辑器工具栏
    assert.match(q.stem, /自我认知与职业目标/, '题干没拿到评分维度表');
    assert.match(q.stem, /报告结构与规范性/, '题干被截断');
    assert.doesNotMatch(q.stem, /段落格式/, '题干混进了编辑器工具栏');
    assert.doesNotMatch(q.stem, /最少\s*1200\s*字/, '题干混进了字数提示');
    // 考试标题里的任务描述补在最前
    assert.ok(q.stem.startsWith('撰写生涯发展报告'), `题干开头不是任务描述：${q.stem.slice(0, 40)}`);

    /* ---------- 写答案 ---------- */
    const filled = await evaluateFn(page, __pageFns.pageFillOne, {
      qid: QID,
      kind: 'text',
      html: '<h2>一、自我认知</h2><p>我性格偏稳，做事有条理。</p>',
    });
    assert.equal(filled.ok, true);
    assert.equal(filled.via, 'textarea', `离线没有 UEditor，应当退 textarea，实际：${filled.via}`);
    assert.ok(filled.len > 0);

    /* ---------- 回读 ---------- */
    const saved = await evaluateFn(page, __pageFns.pageReadAnswers, [QID]);
    assert.ok(!saved.err, `回读失败：${saved.err}`);
    assert.match(saved[QID].text, /自我认知/);
    assert.match(saved[QID].text, /做事有条理/);

    return `读卷 1 题、题干 ${q.stem.length} 字、写入与回读一致`;
  } finally {
    await browser.close();
  }
}

// 允许直接单跑这个文件
if (process.argv[1] && process.argv[1].endsWith('chaoxing-exam-dom.test.mjs')) {
  const detail = await testChaoxingExamDom();
  console.log(`✅ ${detail}`);
}

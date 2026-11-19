/**
 * 学习通「真机页面」结构的回归单测。
 *
 * 这里的每段 HTML 都是从真实的学习通手机端作业页里抠出来的（2026-11 实测），
 * 覆盖三类曾经踩过的坑：
 *   1. 作业列表的作业名在链接**后面**（<li onclick data="URL"><p>作业名</p>）
 *   2. 选项不是 radio/checkbox，而是 div.Answer 里的 span[orichoice]，
 *      且 span 里显示的字母和 orichoice 不一致（页面会打乱顺序）
 *   3. 带 checkIntegrity=true 的链接，服务端会忽略 index（永远第一题）
 */
import assert from 'node:assert/strict';

import * as api from '../lib/chaoxing-api.mjs';
import * as ai from '../lib/chaoxing-ai.mjs';

function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
}

function ok(value, label) {
  assert.ok(value, label);
}

const LIST_HTML = `
<div id="content">
  <ul class="nav">
    <li onclick="goTask(this);" data="https://mooc1-api.chaoxing.com/mooc-ans/android/mtaskmsgspecial?taskrefId=58136411&msgId=0&courseId=265813044&userId=474197272&clazzId=153830884&type=work&enc_task=3aaa3cabad9c9950e95af874a67b9f72">
      <span class="spanImg"><img src=//x/task-work.png><i class="redPoint"></i></span>
      <div role="option">
        <p aria-hidden="true">（选做）5.2.职业榜样的价值探寻</p>
        <span  class="status"  aria-hidden="true">未提交</span>
        <span aria-hidden="true">《2026年秋...》</span>
      </div>
    </li>
    <li onclick="goTask(this);" data="https://mooc1-api.chaoxing.com/mooc-ans/android/mtaskmsgspecial?taskrefId=57607290&courseId=268028241&clazzId=157759096&type=work&enc_task=abc">
      <div role="option">
        <p aria-hidden="true">第二章作业</p>
        <span class="status">已提交</span>
      </div>
    </li>
    <li onclick="goTask(this);" data="https://mooc1-api.chaoxing.com/mooc-ans/android/mtaskmsgspecial?taskrefId=999&courseId=1&type=exam">
      <div role="option"><p aria-hidden="true">这是考试不是作业</p></div>
    </li>
  </ul>
</div>`;

// 真实单选题页（节选）：span 里显示 A/B/C/D，但 orichoice 分别是 D/B/C/A
const PAGE_SINGLE = `
<div class="wid750 singleQuesId" data="406199889">
  <form id="submitTest" action="#" method="post" class="ans-cc-work fontLabel">
    <input type="hidden" id="workRelationAnswerId" name="workRelationAnswerId" value="56576015"/>
    <input type="hidden" id="knowledgeid" name="knowledgeid" value="0"/>
    <input type="hidden" id="enc" name="enc" value="c4469562b9d36e833202ff62d515e479"/>
    <input type="hidden" id="source" name="source" value="0"/>
    <input type="hidden" id="encWork" name="encWork" value="d99d6028df66c11a297100444dbf0c13"/>
    <input type="hidden" id="courseId" name="courseId" value="268028241"/>
    <input type="hidden" id="workRelationId" name="workRelationId" value="57607290" />
    <input type="hidden" id="classId" name="classId" value="157759096" />
    <div class="pad30">
      <div><span class="focusSpan" aria-label="1. 单选题"></span><h2 aria-hidden="true" class="titType">1. 单选题</h2></div>
      <div class="ans-cc timuStyle fontLabel workWrap" ><span aria-label="题干"></span>在计算机存储体系中，访问速度最快的是(&nbsp;&nbsp;&nbsp;&nbsp;)。</div>
      <div id="redioContent"></div>
      <div class="Answer workTextWrap" >
        <span data="answer406199889" class="choose check" aria-label="选项D.光盘" orichoice="D">A</span>
        <div aria-hidden="true" id="D" class="centerSpan workWrap">光盘</div>
      </div>
      <div id="redioContentD" class="redioContentClass"></div>
      <div class="Answer workTextWrap" >
        <span data="answer406199889" class="choose check checked" aria-label="选项B.Cache高速缓存已选择" orichoice="B">B</span>
        <div aria-hidden="true" id="B" class="centerSpan workWrap">Cache高速缓存</div>
      </div>
      <div id="redioContentB" class="redioContentClass"></div>
      <div class="Answer workTextWrap" >
        <span data="answer406199889" class="choose check" aria-label="选项C.硬盘" orichoice="C">C</span>
        <div aria-hidden="true" id="C" class="centerSpan workWrap">硬盘</div>
      </div>
      <div id="redioContentC" class="redioContentClass"></div>
      <div class="Answer workTextWrap" >
        <span data="answer406199889" class="choose check" aria-label="选项A.主存(内存)" orichoice="A">D</span>
        <div aria-hidden="true" id="A" class="centerSpan workWrap">主存(内存)</div>
      </div>
      <div id="redioContentA" class="redioContentClass"></div>
    </div>
    <input type="hidden" name="answer406199889" id="answer406199889"  value="B" class="answerInput"/>
    <input type="hidden" name="type406199889" value="0"/>
    <input type="hidden" name="score406199889" value="2.5"/>
    <input type="hidden" name="questionId" id="questionId" value="406199889"/>
    <input type="hidden" name="index" id="index" value="0"/>
    <input type="hidden" id="tempSave" name="tempSave" value="true">
  </form>
</div>`;

// 真实简答题页（节选）：没有 radio，答案写在隐藏域 answer{qid}（由编辑器写进去）
const PAGE_TEXT = `
<div class="wid750 singleQuesId" data="405668604">
  <form id="submitTest" action="#" method="post" class="ans-cc-work fontLabel">
    <input type="hidden" id="workRelationAnswerId" name="workRelationAnswerId" value="57577632"/>
    <input type="hidden" id="courseId" name="courseId" value="265813044"/>
    <div class="pad30">
      <div><span class="focusSpan" aria-label="1. 简答题"></span><h2 class="titType" aria-hidden="true">1. 简答题</h2></div>
      <div class="ans-cc timuStyle fontLabel workWrap"><span aria-label="题干"></span>我最崇拜的人是谁？</div>
      <div class="Briefanswer">
        <div class="jdt" style="padding:0px;border:none">
          <div id="ananas-editor-answer"><span aria-label="未作答轻点两下来编辑" id="answerAria"></span></div>
          <input type="hidden" name="answer405668604" id="answerEditor" value='' class="answerInput" />
        </div>
      </div>
      <input type="hidden" name="type405668604" value="4"/>
      <input type="hidden" name="score405668604" value="1.0"/>
      <input type="hidden" name="questionId" id="questionId" value="405668604"/>
      <input type="hidden" name="index" id="index" value="0"/>
    </div>
  </form>
</div>`;

const BASE_URL =
  'https://mooc1-api.chaoxing.com/mooc-ans/work/phone/doHomeWork?courseId=265813044&workId=58136411&cpi=576538403&workAnswerId=57577632&classId=153830884&oldWorkId=&mooc=1&msgId=0&source=0&checkIntegrity=true&enc=da2caf5bd73100757f7e7e1ab5e9018d&status=1';

export default async function run() {
  let n = 0;

  // ── 1. 作业列表：作业名在链接后面 ─────────────────────────────────────────
  const links = api.parseTaskLinks(LIST_HTML);
  eq(links.length, 2, '只认 type=work 的链接');
  eq(links[0].title, '（选做）5.2.职业榜样的价值探寻', '作业名取链接后的 <p>');
  eq(links[0].taskrefId, '58136411', 'taskrefId 正确');
  eq(links[0].courseId, '265813044', 'courseId 正确');
  eq(links[0].status, '未提交', '状态取 span.status');
  eq(links[0].submitted, false, '未提交 → submitted=false');
  eq(links[1].title, '第二章作业', '第二条作业名正确');
  eq(links[1].submitted, true, '已提交 → submitted=true');
  ok(!links.some((l) => l.title.includes('goTask')), '标题里不能混进 <li onclick> 标签');
  n += 8;

  // ── 2. 翻页参数：必须摘掉 checkIntegrity ────────────────────────────────
  const indexed = api.withIndex(BASE_URL, 3);
  const u = new URL(indexed);
  eq(u.searchParams.get('index'), '3', 'index 要写进去');
  eq(u.searchParams.has('checkIntegrity'), false, 'checkIntegrity 必须摘掉（否则服务端永远返回第 1 题）');
  eq(u.searchParams.get('knowledgeid'), '0', '缺 knowledgeid 时补 0');
  eq(u.searchParams.get('enc'), 'da2caf5bd73100757f7e7e1ab5e9018d', 'enc 不能动');
  const keep = api.withIndex(BASE_URL + '&knowledgeid=77', 1);
  eq(new URL(keep).searchParams.get('knowledgeid'), '77', '已有 knowledgeid 不覆盖');
  n += 5;

  // ── 3. 单选：选项值取 orichoice，不是 span 里的字母 ──────────────────────
  const single = api.parseQuestionPage(PAGE_SINGLE);
  eq(single.questionId, '406199889', 'qid 解析');
  eq(single.type, '0', '题型编号');
  eq(single.kind, 'single', 'radio 结构缺失也能认出单选');
  eq(single.score, '2.5', '分值');
  eq(single.options.length, 4, '四个选项');
  eq(single.options.map((o) => o.value), ['D', 'B', 'C', 'A'], '选项值来自 orichoice');
  eq(single.options.map((o) => o.label), ['光盘', 'Cache高速缓存', '硬盘', '主存(内存)'], '选项文字来自 centerSpan');
  eq(single.options.filter((o) => o.checked).map((o) => o.value), ['B'], '已选项带 checked 标记');
  ok(single.stem.includes('访问速度最快'), '题干解析');
  ok(!single.stem.includes('orichoice'), '题干里不能混进标签属性');
  eq(single.fields.answer406199889, 'B', '隐藏域里的原答案能读到');
  n += 10;

  // ── 4. 简答：没有选项，也要认成 text 而不是 unknown ─────────────────────
  const text = api.parseQuestionPage(PAGE_TEXT);
  eq(text.questionId, '405668604', '简答 qid');
  eq(text.type, '4', '简答题型编号');
  eq(text.kind, 'text', '简答必须是 text（不是 blank）');
  eq(text.options.length, 0, '简答没有选项');
  eq(text.fields.type405668604, '4', '题型隐藏域');
  ok(text.stem.includes('我最崇拜的人是谁'), '题干解析');
  n += 6;

  // ── 5. 实体解码：数字实体（真实页面上题干常被转成 &#31532; 这种） ──────────
  eq(api.decodeEntities('&#31532;&#19968;&#31456;'), '第一章', '十进制数字实体');
  eq(api.decodeEntities('&#x7b2c;&#x4e00;'), '第一', '十六进制数字实体');
  eq(api.decodeEntities('&lt;b&gt;&amp;'), '<b>&', '命名实体');
  n += 3;

  // ── 6. 回读：简答答案藏在单引号、可跨行的 hidden value 里 ────────────────
  const SAVED_TEXT_HTML = `
  <div class="wid750 singleQuesId" data="405668598">
    <input type="hidden" name="questionId" value="405668598">
    <input type="hidden" name="type405668598" value="4">
    <div id="ananas-editor-answer">
      <span aria-label="已作答《我的职业楷模》探索 一、楷模人物简介 南仁东" id="answerAria"></span>
    </div>
    <input type="hidden" name="answer405668598" id="answerEditor" value='《我的职业楷模》探索
一、楷模人物简介“中国天眼”南仁东，含双引号"测试"'>
  </div>`;
  const savedFields = api.extractHiddenFields(SAVED_TEXT_HTML);
  ok(savedFields.answer405668598.includes('南仁东'), '简答答案要能从单引号、跨行的 value 里读出来');
  ok(savedFields.answer405668598.includes('测试'), 'value 里含双引号也不能被截断');
  eq(savedFields.questionId, '405668598', '普通隐藏域照旧');
  eq(
    api.readEditorText(SAVED_TEXT_HTML),
    '《我的职业楷模》探索 一、楷模人物简介 南仁东',
    'aria-label 兜底，去掉「已作答」前缀',
  );
  eq(api.scanTags('<input value="a>b"><input value=\'c\'>', 'input').length, 2, 'scanTags 认引号，value 里有 > 也不截断');
  n += 5;

  // ── 7. 列表状态：已完成的作业状态 span 没有 class="status" ────────────────
  const LIST_DONE = `
    <li onclick="goTask(this);" data="https://mooc1-api.chaoxing.com/mooc-ans/android/mtaskmsgspecial?taskrefId=57607290&type=work&enc_task=x">
      <div role="option">
        <p aria-hidden="true">第二章作业</p>
        <span aria-hidden="true">已完成</span>
        <span aria-hidden="true">《软件工程专业...》</span>
        <span class="fr" aria-hidden="true">剩余50小时21分钟</span>
        <span aria-label="作业名称第二章作业作业状态已完成所属课程软件工程专业...剩余时间剩余50小时21分钟"></span>
      </div>
    </li>`;
  const LIST_OPEN = `
    <li onclick="goTask(this);" data="https://mooc1-api.chaoxing.com/mooc-ans/android/mtaskmsgspecial?taskrefId=58136411&type=work&enc_task=y">
      <div role="option">
        <p aria-hidden="true">（选做）5.2.职业榜样的价值探寻</p>
        <span class="status" aria-hidden="true">未提交</span>
        <span aria-label="作业名称（选做）5.2.职业榜样的价值探寻作业状态未提交所属课程2026年秋..."></span>
      </div>
    </li>`;
  const done = api.parseTaskLinks(LIST_DONE)[0];
  const open = api.parseTaskLinks(LIST_OPEN)[0];
  eq(done.title, '第二章作业', '已完成那条的标题照旧');
  eq(done.status, '已完成', '没 class 的状态 span 也要认出来');
  eq(done.done, true, '已完成 → done=true');
  eq(open.status, '未提交', '有 class="status" 的照旧');
  eq(open.done, false, '未提交 → done=false');
  n += 5;

  // 8. 图片题答案的 HTML 拼装
  const html1 = api.imageAnswerHtml('https://p.cldisk.com/a/b/origin.png', { body: '补充一句' });
  assert(html1.includes('<img src="https://p.cldisk.com/a/b/origin.png"'), '图片答案必须带 <img src>');
  assert(html1.includes('<p>补充一句</p>'), '正文要跟在图后面');
  const html2 = api.imageAnswerHtml('https://x/y.png', { caption: '人生轨迹图：' });
  assert(html2.startsWith('<p>人生轨迹图：</p>'), '导语在最前面');
  assert(!html2.includes('<p></p>'), '没正文就不要留空 <p>');
  assert(api.imageAnswerHtml('u').startsWith('<p><img'), '只给 url 也成立');
  n += 5;

  // ── 9. 整卷页 / 多选题模板：div.answerBg + span.num_option_dx[data] ─────
  // 这是 2026-11-19 实际翻车的那一版：单选题走 span[orichoice]，
  // 多选题换成这套模板，解析器只认前者 → 多选 opts=0 → 判 unknown →
  // 按主观题把中文塞进 answer 字段 → 平台全判 0 分。
  const PAGE_MULTI = `
<div class="whiteDiv">
  <div class="padBom50 questionLi fontLabel singleQuesId" typeName="多选题" id="question406411966" data="406411966">
    <h3 class="mark_name"><span class="colorShallow">(多选题, 1分)</span>人生观主要包括哪三个方面的内容（ ）</h3>
    <input type="hidden" id="answertype406411966" name="answertype406411966" value="1" />
    <input type="hidden" id="answer406411966" name="answer406411966" value="" />
    <div class="stem_answer qtDetail">
      <div class="clearfix answerBg workTextWrap" onclick="addMultipleChoice(this);" role="checkbox" aria-label='A 人生目的选择' qid="406411966" qtype="1">
        <span aria-hidden="true" data="A" class="choice406411966 num_option_dx fl">A</span>
        <div aria-hidden="true" class="fl answer_p"><p>人生目的</p></div>
      </div>
      <div class="clearfix answerBg workTextWrap" onclick="addMultipleChoice(this);" role="checkbox" aria-label='B 人生态度选择' qid="406411966" qtype="1">
        <span aria-hidden="true" data="B" class="choice406411966 num_option_dx fl">B</span>
        <div aria-hidden="true" class="fl answer_p"><p>人生态度</p></div>
      </div>
      <div class="clearfix answerBg workTextWrap" onclick="addMultipleChoice(this);" role="checkbox" aria-label='C 人生价值选择' qid="406411966" qtype="1">
        <span aria-hidden="true" data="C" class="choice406411966 num_option_dx check_answer_dx fl">C</span>
        <div aria-hidden="true" class="fl answer_p"><p>人生价值</p></div>
      </div>
      <div class="clearfix answerBg workTextWrap" onclick="addMultipleChoice(this);" role="checkbox" aria-label='D 人生理想选择' qid="406411966" qtype="1">
        <span aria-hidden="true" data="D" class="choice406411966 num_option_dx fl">D</span>
        <div aria-hidden="true" class="fl answer_p"><p>人生理想</p></div>
      </div>
    </div>
  </div>
</div>`;
  const multi = api.parseQuestionPage(PAGE_MULTI, { questionId: '406411966' });
  eq(multi.kind, 'multiple', '多选题必须认成 multiple（不能落成 unknown）');
  eq(multi.type, '1', '题型编号从 answertype{qid} 也读得到');
  eq(multi.options.map((o) => o.value), ['A', 'B', 'C', 'D'], '选项值取 span[data]');
  eq(multi.options.map((o) => o.label), ['人生目的', '人生态度', '人生价值', '人生理想'], '选项文字取 answer_p');
  eq(multi.options.filter((o) => o.checked).map((o) => o.value), ['C'], '选中态看 num_option_dx.check_answer_dx');
  ok(multi.options.every((o) => o.multiple), '每个选项都标 multiple，用于题型兜底');
  ok(multi.stem.includes('人生观主要包括'), '题干解析');
  n += 7;

  // 单选同一套模板（role=radio / num_option）
  const PAGE_RADIO_BOX = `
<div class="questionLi singleQuesId" id="question406411954" data="406411954">
  <input type="hidden" id="answertype406411954" name="answertype406411954" value="0" />
  <div role="radio" aria-label='A 经济关系选择' qid="406411954" qtype="0" class="clearfix answerBg">
    <span data="A" class="choice406411954 num_option fl">A</span>
    <div class="fl answer_p"><p>经济关系</p></div>
  </div>
  <div role="radio" aria-label='B 社会关系选择' qid="406411954" qtype="0" class="clearfix answerBg">
    <span data="B" class="choice406411954 num_option fl">B</span>
    <div class="fl answer_p"><p>社会关系</p></div>
  </div>
</div>`;
  const radioBox = api.parseQuestionPage(PAGE_RADIO_BOX, { questionId: '406411954' });
  eq(radioBox.kind, 'single', '单选模板 → single');
  eq(radioBox.options.map((o) => o.value), ['A', 'B'], '单选选项值');
  ok(!radioBox.options.some((o) => o.multiple), '单选不标 multiple');
  n += 3;

  // 归一化兜底：题型没认出来但有选项时，必须还按选项字母作答，不能原文照发
  const fakeMulti = { ...multi, kind: 'unknown' };
  const norm = ai.normalizeAnswer(fakeMulti, '人生目的、人生态度、人生价值');
  ok(Array.isArray(norm.value), 'unknown + 有选项 → 仍按多选返回数组');
  eq(norm.value, ['A', 'B', 'C'], '模型给中文选项内容也能反查成字母');
  const normLetter = ai.normalizeAnswer(fakeMulti, 'ABC');
  eq(normLetter.value, ['A', 'B', 'C'], '直接给字母照旧');
  n += 3;

  return `学习通真机结构单测：${n} 条断言全过（列表标题/翻页参数/手机端选项/简答识别/实体解码/简答回读/作业状态/图片答案/多选模板）`;
}

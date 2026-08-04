const express = require('express');

const { runPipeline, normalizeIntake } = require('./src/pipeline');
const { buildReportHtml, buildCategoryScores, gradeOf, allItemsHtml } = require('./src/reportBuilder');
const { buildPremiumSnippets } = require('./src/snippetBuilder');
const { buildCompletionMessage } = require('./src/messenger');
const { isMockMode } = require('./src/openaiClient');
const { saveJob, loadJob } = require('./src/jobStore');
const { kvGet, kvSet } = require('./src/kv');
const checklist = require('./config/checklist.json');

const app = express();
const PORT = process.env.PORT || 4174;

function newJobId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// 산출물(리포트/스키마/llms.txt)도 kv.js에 저장한다 — 로컬 output/ 폴더는 Render 재시작 시
// 초기화되므로 다운로드 링크가 파일시스템에 의존하면 안 된다.
app.get('/output/:fileName', async (req, res) => {
  const content = await kvGet(`output:${req.params.fileName}`);
  if (content == null) {
    return res.status(404).send('파일을 찾을 수 없습니다. 링크가 만료되었을 수 있습니다.');
  }
  const contentType = req.params.fileName.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';
  res.type(contentType).send(content);
});

app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Zapier/Make → 이 웹훅으로 설문 답변을 그대로 POST하면 사람이 대시보드 폼에 재입력할 필요 없이
// 진단이 자동 실행되고, 결과는 review URL로 검수 대기 상태가 된다. .env에 WEBHOOK_TOKEN을 설정해야
// 동작한다(미설정 시 503) — 외부에 노출될 수 있는 엔드포인트라 기본값으로 열어두지 않는다.
function checkWebhookToken(req, res, next) {
  const configured = process.env.WEBHOOK_TOKEN || '';
  if (!configured) {
    return res.status(503).json({ error: 'WEBHOOK_TOKEN이 서버에 설정되어 있지 않습니다. .env에 WEBHOOK_TOKEN을 설정한 뒤 다시 시도하세요.' });
  }
  const authHeader = req.get('Authorization') || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.get('X-Webhook-Token') || '');
  if (provided !== configured) {
    return res.status(401).json({ error: '인증 실패: 유효하지 않거나 누락된 웹훅 토큰입니다.' });
  }
  next();
}

const INDUSTRY_OPTIONS = ['병원', '부동산', '학원', '쇼핑몰', '제조업B2B', '프랜차이즈', '컨설팅', '법률세무노무', '지역매장', '기타'];

function baseStyles() {
  return `
    :root {
      --bg:#F1F4F1; --surface:#FFFFFF; --surface-2:#E7ECE8; --border:#D3DBD5;
      --ink:#12201B; --ink-dim:#55665D; --accent:#2E8A72; --accent-strong:#1F6E58;
      --accent-wash:#DFEEE8; --good:#2F8F52; --good-wash:#E1F0E4; --crit:#B14839; --crit-wash:#F6E1DD;
      --warn:#B08A2E; --warn-wash:#F3EAD7;
    }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#0D1210; --surface:#161C19; --surface-2:#1E2622; --border:#2A332E;
        --ink:#E8ECE9; --ink-dim:#93A49B; --accent:#3FA88C; --accent-strong:#59C9A8;
        --accent-wash:#1B2D28; --good:#5FBE7C; --good-wash:#17281C; --crit:#D9776A; --crit-wash:#2E1B18;
        --warn:#D9B15F; --warn-wash:#2E2716; }
    }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif; }
    .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-variant-numeric: tabular-nums; }
    .page { max-width: 860px; margin: 0 auto; padding: 40px 24px 64px; }
    h1 { font-size: 21px; font-weight: 800; margin: 0 0 6px; }
    h2 { font-size: 15px; font-weight: 800; margin: 30px 0 10px; }
    p.lead { color: var(--ink-dim); font-size: 13.5px; margin: 0 0 20px; }
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 22px; margin-top: 14px; }
    fieldset { border: none; padding: 0; margin: 0 0 18px; }
    legend { font-size:12.5px; font-weight:800; color:var(--accent-strong); text-transform:uppercase; letter-spacing:0.03em; margin-bottom:8px; padding:0; }
    label { display:block; font-size:12.5px; font-weight:700; color:var(--ink-dim); margin: 14px 0 6px; }
    label:first-of-type { margin-top: 0; }
    .row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    select, input[type=text], input[type=url], input[type=date], textarea {
      width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--border);
      background: var(--surface-2); color: var(--ink); font-size: 13.5px; font-family:inherit;
    }
    textarea { min-height: 70px; resize: vertical; }
    textarea.mono-area { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size:12px; min-height:160px; }
    button, .btn {
      display:inline-block; margin-top: 22px; padding: 12px 20px; border-radius: 8px; border: none;
      background: var(--accent); color: white; font-size: 14px; font-weight: 700; cursor: pointer; text-decoration:none;
    }
    button:hover, .btn:hover { background: var(--accent-strong); }
    .btn-secondary { background: var(--surface-2); color: var(--ink); }
    .kpi-row { display:flex; gap:12px; margin: 4px 0 18px; flex-wrap: wrap; align-items:center; }
    .grade-badge { font-size: 30px; font-weight: 900; width: 58px; height: 58px; border-radius: 12px; display:flex; align-items:center; justify-content:center; }
    .grade-A, .grade-B { background: var(--good-wash); color: var(--good); }
    .grade-C { background: var(--warn-wash); color: var(--warn); }
    .grade-D, .grade-F { background: var(--crit-wash); color: var(--crit); }
    .score-num { font-size: 26px; font-weight: 800; }
    .score-sub { color: var(--ink-dim); font-size: 11.5px; }
    table { width:100%; border-collapse:collapse; font-size:12.5px; margin-top:8px; }
    th { text-align:left; color:var(--ink-dim); font-size:11px; text-transform:uppercase; padding:6px 8px; border-bottom:1px solid var(--border); }
    td { padding:7px 8px; border-bottom:1px solid var(--border); vertical-align:top; }
    .cat-bar-wrap { background:var(--surface-2); border-radius:6px; height:8px; width:100%; overflow:hidden; }
    .cat-bar { background:var(--accent); height:100%; }
    .cat-heading { font-size:12.5px; font-weight:800; margin:16px 0 6px; }
    .cat-heading:first-child { margin-top:0; }
    .top5-item { padding:10px 0; border-bottom:1px solid var(--border); font-size:13px; }
    .top5-item:last-child { border-bottom:none; }
    .top5-no { display:inline-block; min-width:20px; height:20px; border-radius:6px; background:var(--accent-wash); color:var(--accent-strong); font-size:11.5px; font-weight:800; text-align:center; line-height:20px; margin-right:6px; }
    .faq-edit { border:1px solid var(--border); border-radius:8px; padding:14px; margin-top:12px; background:var(--surface-2); }
    .badge { display:inline-block; padding:3px 9px; border-radius:999px; font-size:11px; font-weight:700; }
    .badge-mock { background:var(--warn-wash); color:var(--warn); }
    .badge-live { background:var(--good-wash); color:var(--good); }
    .note-box { background:var(--warn-wash); color:var(--warn); border-radius:8px; padding:14px 16px; font-size:12.5px; line-height:1.6; margin-top:20px; }
    .back { display:inline-block; margin-top: 20px; color: var(--ink-dim); font-size: 13px; text-decoration:none; }
    .error-box { background: var(--crit-wash); color: var(--crit); border-radius: 8px; padding: 14px 16px; font-size: 13.5px; }
    .dl-list { list-style:none; padding:0; margin:12px 0 0; }
    .dl-list li { margin-bottom:8px; }
  `;
}

function layout(title, body) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
  <title>${title}</title><style>${baseStyles()}</style></head>
  <body><div class="page">${body}</div></body></html>`;
}

function modeBadge() {
  return isMockMode()
    ? '<span class="badge badge-mock">MOCK 모드 (OPENAI_API_KEY 없음)</span>'
    : '<span class="badge badge-live">실 API 연동 중</span>';
}

function renderIntakeForm() {
  const industryOptions = INDUSTRY_OPTIONS.map((o) => `<option value="${o}">${o}</option>`).join('');
  return layout('AEO·GEO 진단 대시보드', `
    <h1>AEO·GEO 노출 최적화 진단</h1>
    <p class="lead">URL(또는 테스트용 HTML)과 인테이크 설문 답변을 입력하면 패키지에 맞춰 진단·콘텐츠·코드 스니펫까지 생성됩니다. ${modeBadge()}</p>
    <div class="panel">
      <form action="/diagnose" method="post">
        <fieldset>
          <legend>진단 대상</legend>
          <label>1. 사이트/블로그 URL (q1_url)</label>
          <input type="url" name="q1_url" placeholder="https://example.com">
          <label>테스트용 HTML 직접 입력 (URL 접속이 어려운 경우 — 있으면 URL 대신 이 내용으로 진단)</label>
          <textarea name="rawHtml" class="mono-area" placeholder="&lt;html&gt;...&lt;/html&gt;"></textarea>
        </fieldset>

        <fieldset>
          <legend>인테이크 설문 (SOP §2)</legend>
          <label>2. 업종</label>
          <select name="q2_industry">${industryOptions}</select>

          <div class="row2">
            <div><label>3. 브랜드명</label><input type="text" name="q3_brand_name"></div>
            <div><label>한줄 소개</label><input type="text" name="q3_brand_intro"></div>
          </div>

          <label>4. 주요 제공 서비스·상품 (최대 3개)</label>
          <div class="row2">
            <input type="text" name="q4_service1" placeholder="서비스1">
            <input type="text" name="q4_service2" placeholder="서비스2">
          </div>
          <input type="text" name="q4_service3" placeholder="서비스3" style="margin-top:8px;">

          <label>5. 핵심 타깃 고객층</label>
          <input type="text" name="q5_target_customer">

          <label>6. 고객이 자주 묻는 질문 3가지(아는 대로, 쉼표/줄바꿈 구분)</label>
          <textarea name="q6_faq_questions"></textarea>

          <label>7. 벤치마킹하는 경쟁사(있다면)</label>
          <input type="text" name="q7_competitors">

          <div class="row2">
            <div><label>8. 기존 FAQ 페이지 유무</label>
              <select name="q8_existing_faq"><option value="없음">없음</option><option value="있음">있음</option></select>
            </div>
            <div><label>11. 사이트 관리자 권한 보유 여부 (DELUXE·PREMIUM)</label>
              <select name="q11_admin_access"><option value="있음">있음</option><option value="없음">없음</option></select>
            </div>
          </div>

          <label>9. 브랜드 차별점·전문성 근거(자격·경력·사례)</label>
          <textarea name="q9_differentiators"></textarea>

          <label>10. 연락처·사업자정보</label>
          <input type="text" name="q10_contact_info">

          <label>12. 30일 후 재점검 희망 일정 (PREMIUM)</label>
          <input type="date" name="q12_recheck_date">

          <label>13. 위 URL은 홈페이지(자체 도메인)인가요, 블로그인가요?</label>
          <select name="q13_url_type">
            <option value="홈페이지">홈페이지 (자체 도메인)</option>
            <option value="블로그">블로그 (네이버 블로그·티스토리 등 플랫폼, 커스텀 도메인 연결 포함)</option>
            <option value="모르겠음">모르겠음</option>
          </select>
        </fieldset>

        <fieldset>
          <legend>패키지 선택</legend>
          <select name="packageTier">
            <option value="standard">STANDARD — 30항목 진단 + 우선순위 Top5 리포트</option>
            <option value="deluxe">DELUXE — STANDARD + FAQ·문구 5건 초안</option>
            <option value="premium">PREMIUM — DELUXE + 콘텐츠 10~15건 + 스키마·llms.txt 코드</option>
          </select>
        </fieldset>

        <button type="submit">진단 실행</button>
      </form>
    </div>
  `);
}

function renderErrorPage(message) {
  return layout('오류', `
    <h1>처리 중 오류 발생</h1>
    <div class="error-box">${message}</div>
    <a class="back" href="/">← 처음으로</a>
  `);
}

function categoryRowsHtml(categoryScores) {
  return categoryScores.map((c) => {
    const pct = c.max ? Math.round((c.score / c.max) * 100) : 0;
    return `<tr>
      <td>${c.code}. ${c.name}</td>
      <td>${c.methodLabel}</td>
      <td class="mono">${c.score} / ${c.max}</td>
      <td style="width:110px;"><div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;"></div></div></td>
    </tr>`;
  }).join('');
}

function top5RowsHtml(top5) {
  if (!top5.length) return '<p class="lead">우선순위 항목 없음</p>';
  return top5.map((t, i) => `<div class="top5-item"><span class="top5-no mono">${i + 1}</span><strong>${t.no}. ${t.text}</strong><div class="score-sub">${t.reason}</div></div>`).join('');
}

function faqEditHtml(faqs) {
  return (faqs || []).map((f, i) => `
    <div class="faq-edit">
      <label>질문 ${i + 1}</label>
      <input type="text" name="faq_q_${i}" value="${(f.question || '').replace(/"/g, '&quot;')}">
      <label>답변 ${i + 1}</label>
      <textarea name="faq_a_${i}">${f.answer || ''}</textarea>
    </div>`).join('');
}

function renderReviewPage(jobId, job) {
  const { allItems, top5, content, packageTier, intake, aiMode, site } = job;
  const categoryScores = buildCategoryScores(allItems);
  const totalScore = categoryScores.reduce((s, c) => s + c.score, 0);
  const grade = gradeOf(totalScore);
  const packageLabel = { standard: 'STANDARD', deluxe: 'DELUXE', premium: 'PREMIUM' }[packageTier];
  const platformHosted = Boolean(site && site.llmsTxt && site.llmsTxt.platformHosted);
  const platformNote = platformHosted
    ? '<div class="note-box">⚠ 판별: 네이버 블로그 등 제3자 블로그 플랫폼 — llms.txt/sitemap.xml/스키마 등 코드 설치가 필요한 항목과 내부링크·메뉴구조·브레드크럼처럼 플랫폼 템플릿에 좌우되는 항목은 중립 처리됨. 오판별이면 리포트 전달 전 확인 필요.</div>'
    : '';

  const contentSection = content ? `
    <h2>FAQ·Q&A 콘텐츠 초안 (${content.faqs.length}건) — 검수 후 필요시 직접 수정하세요</h2>
    <div class="panel">
      <input type="hidden" name="faqCount" value="${content.faqs.length}">
      ${faqEditHtml(content.faqs)}
      <label>브랜드소개 문구 개선안</label>
      <textarea class="mono-area" name="improvedCopy">${content.improvedCopy || ''}</textarea>
    </div>
    ${packageTier === 'premium' ? '<p class="lead">FAQPage 스키마·llms.txt 코드는 위 FAQ 내용을 기준으로 "내보내기" 시 최신 상태로 다시 생성됩니다.</p>' : ''}
  ` : '';

  return layout('검수 화면', `
    <h1>${intake.brandName || '브랜드'} — 진단 결과 검수</h1>
    <p class="lead">${packageLabel} · 대상: ${intake.url || '(테스트용 HTML)'} · AI 평가 모드: ${aiMode}</p>
    ${platformNote}

    <div class="panel">
      <div class="kpi-row">
        <div class="grade-badge grade-${grade}">${grade}</div>
        <div><div class="score-num mono">${totalScore} / ${checklist.maxScore}</div><div class="score-sub">60점 만점 · 6개 카테고리</div></div>
      </div>
      <table><thead><tr><th>카테고리</th><th>채점방식</th><th>점수</th><th></th></tr></thead>
        <tbody>${categoryRowsHtml(categoryScores)}</tbody></table>
    </div>

    <h2>개선 우선순위 Top 5 (전체 30항목 기준)</h2>
    <div class="panel">${top5RowsHtml(top5)}</div>

    <h2>전체 30항목 상세 결과</h2>
    <div class="panel">${allItemsHtml(categoryScores)}</div>

    <form action="/export/${jobId}" method="post">
      ${contentSection}
      <div class="note-box">이 화면은 검수 전 단계입니다. "검수 완료 후 내보내기"를 눌러야 리포트/코드 파일이 생성됩니다.
      자동 발송은 지원하지 않으며, 전달은 항상 사람이 최종 확인한 뒤 이루어집니다.</div>
      <button type="submit">검수 완료 후 내보내기</button>
    </form>
    <a class="back" href="/">← 새 진단 시작</a>
  `);
}

function renderExportPage(job, exportResult) {
  const { intake, packageTier } = job;
  const packageLabel = { standard: 'STANDARD', deluxe: 'DELUXE', premium: 'PREMIUM' }[packageTier];
  const files = exportResult.files.map((f) => `<li><a class="btn btn-secondary" href="/output/${encodeURIComponent(f.name)}" download>${f.label}</a></li>`).join('');

  return layout('내보내기 완료', `
    <h1>내보내기 완료 — ${intake.brandName || '브랜드'}</h1>
    <p class="lead">${packageLabel} 산출물이 생성되었습니다. 아래 파일을 확인 후 전달하세요.</p>
    <div class="panel">
      <h2 style="margin-top:0;">산출물 다운로드</h2>
      <ul class="dl-list">${files}</ul>
    </div>
    <div class="panel">
      <h2 style="margin-top:0;">완료 전달 메시지 (복사용 — 자동 발송 아님)</h2>
      <textarea class="mono-area" readonly>${exportResult.completionMessage}</textarea>
      <p class="lead" style="margin-top:10px;">크몽 주문 감지·실제 발송은 이 도구의 범위 밖입니다(Zapier/Make 워크플로우에서 처리). 위 문구를 검수 후 수동으로 전달하세요.</p>
    </div>
    <a class="back" href="/">← 새 진단 시작</a>
  `);
}

// 사람이 대시보드 폼으로 입력하든, 웹훅으로 자동 입력되든 진단 실행 로직은 동일하다.
async function createDiagnosisJob(body) {
  const intake = normalizeIntake(body);
  const packageTier = body.packageTier || 'standard';
  const rawHtml = (body.rawHtml || '').trim() || undefined;
  const result = await runPipeline({ intake, packageTier, rawHtml });
  const jobId = newJobId();
  await saveJob(jobId, result);
  return { jobId, result };
}

app.get('/', (req, res) => {
  res.send(renderIntakeForm());
});

app.post('/diagnose', async (req, res) => {
  try {
    const { jobId, result } = await createDiagnosisJob(req.body);
    res.send(renderReviewPage(jobId, result));
  } catch (err) {
    res.status(400).send(renderErrorPage(err.message));
  }
});

// 진단이 이미 끝난 작업의 검수 화면을 다시 연다 — 웹훅이 돌려준 reviewUrl로 사람이 들어오는 경로.
app.get('/review/:jobId', async (req, res) => {
  const job = await loadJob(req.params.jobId);
  if (!job) {
    return res.status(404).send(renderErrorPage('검수 세션을 찾을 수 없습니다. 서버가 재시작되었거나 만료되었을 수 있습니다.'));
  }
  res.send(renderReviewPage(req.params.jobId, job));
});

// Zapier/Make 웹훅 진입점. 구글시트에 새 설문 응답 행이 생기면 이 엔드포인트로 그 값을 그대로
// POST하도록 연결한다 — 사람이 대시보드 폼에 재입력하지 않아도 진단이 자동 실행된다.
// 검수·내보내기는 여전히 사람이 reviewUrl로 들어와 처리한다(자동 발송 없음, 자동 export 없음).
app.post('/api/diagnose', checkWebhookToken, express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { jobId, result } = await createDiagnosisJob(req.body || {});
    const categoryScores = buildCategoryScores(result.allItems);
    const totalScore = categoryScores.reduce((sum, c) => sum + c.score, 0);
    const grade = gradeOf(totalScore);

    res.status(201).json({
      jobId,
      reviewUrl: `${req.protocol}://${req.get('host')}/review/${jobId}`,
      packageTier: result.packageTier,
      brandName: result.intake.brandName || null,
      totalScore,
      maxScore: checklist.maxScore,
      grade,
      aiMode: result.aiMode,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/export/:jobId', async (req, res) => {
  const job = await loadJob(req.params.jobId);
  if (!job) {
    return res.status(404).send(renderErrorPage('검수 세션을 찾을 수 없습니다. 진단을 다시 실행해주세요.'));
  }

  try {
    // 검수 화면에서 수정한 FAQ/문구를 반영. PREMIUM 코드 스니펫은 수정된 FAQ 기준으로 다시 생성한다.
    if (job.content) {
      const count = parseInt(req.body.faqCount, 10) || job.content.faqs.length;
      const editedFaqs = [];
      for (let i = 0; i < count; i += 1) {
        const question = (req.body[`faq_q_${i}`] || '').trim();
        const answer = (req.body[`faq_a_${i}`] || '').trim();
        if (question) editedFaqs.push({ question, answer });
      }
      job.content.faqs = editedFaqs;
      job.content.improvedCopy = (req.body.improvedCopy || '').trim();

      if (job.packageTier === 'premium') {
        job.snippets = buildPremiumSnippets({ intake: job.intake, faqs: editedFaqs });
      }
    }

    const safeBrand = (job.intake.brandName || 'client').replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
    const stamp = Date.now();
    const files = [];

    // 리포트/스키마/llms.txt는 로컬 파일 대신 kv.js(외부 영구 저장소)에 저장하고,
    // /output/:fileName 라우트가 거기서 읽어 서빙한다(Render 재시작에도 다운로드 링크가 살아있도록).
    const { html: reportHtml } = buildReportHtml({
      intake: job.intake,
      packageTier: job.packageTier,
      allItems: job.allItems,
      top5: job.top5,
      faqs: job.content ? job.content.faqs : null,
      improvedCopy: job.content ? job.content.improvedCopy : null,
      snippets: job.snippets,
      platformHosted: Boolean(job.site && job.site.llmsTxt && job.site.llmsTxt.platformHosted),
      adminAccess: job.intake.adminAccess,
    });
    const reportFileName = `report_${safeBrand}_${job.packageTier}_${stamp}.html`;
    await kvSet(`output:${reportFileName}`, reportHtml);
    files.push({ name: reportFileName, label: '진단 리포트 (.html)' });

    if (job.snippets) {
      const schemaFileName = `faq-schema_${safeBrand}_${stamp}.html`;
      await kvSet(`output:${schemaFileName}`, job.snippets.faqSchemaHtml);
      files.push({ name: schemaFileName, label: 'FAQPage 스키마 코드 (.html)' });

      const llmsFileName = `llms_${safeBrand}_${stamp}.txt`;
      await kvSet(`output:${llmsFileName}`, job.snippets.llmsTxt);
      files.push({ name: llmsFileName, label: 'llms.txt' });
    }

    const completionMessage = buildCompletionMessage({
      brandName: job.intake.brandName || '고객',
      packageTier: job.packageTier,
      deliverableLink: `${req.protocol}://${req.get('host')}/output/${encodeURIComponent(reportFileName)}`,
    });

    job.exported = true;
    await saveJob(req.params.jobId, job); // 검수 중 수정한 최종본을 남겨 재조회·감사 추적이 가능하도록 반영
    res.send(renderExportPage(job, { files, completionMessage }));
  } catch (err) {
    res.status(500).send(renderErrorPage(err.message));
  }
});

app.listen(PORT, () => {
  console.log(`\nAEO·GEO 진단 대시보드 실행 중: http://localhost:${PORT}`);
  console.log(isMockMode() ? '[모드] OPENAI_API_KEY 없음 — mock으로 동작합니다.\n' : '[모드] 실 OpenAI API로 동작합니다.\n');
});

module.exports = app;

// 진단 리포트 조립. templates/report-template.html의 {{TOKEN}} 자리를 채워
// output/에 완성된 단일 HTML 파일로 저장한다 (docx/Google Docs 대신 로컬 렌더링 — SOP §9 참고).
const fs = require('fs');
const path = require('path');

const checklist = require('../config/checklist.json');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'report-template.html');
const PACKAGE_LABELS = { standard: 'STANDARD', deluxe: 'DELUXE', premium: 'PREMIUM' };

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function gradeOf(score) {
  const band = checklist.grades.find((g) => score >= g.min && score <= g.max);
  return band ? band.grade : 'F';
}

// 30항목 채점 결과(allItems)를 checklist.json의 카테고리 정의에 맞춰 6개 그룹으로 묶는다.
function buildCategoryScores(allItems) {
  return checklist.categories.map((cat) => {
    const items = cat.items.map((def) => {
      const found = allItems.find((it) => it.no === def.no);
      return { ...def, score: found ? found.score : 0, reason: found ? found.reason : '채점 결과 없음' };
    });
    const score = items.reduce((sum, it) => sum + it.score, 0);
    return { code: cat.code, name: cat.name, methodLabel: cat.methodLabel, items, score, max: cat.items.length * 2 };
  });
}

function categoryTableRows(categoryScores) {
  return categoryScores.map((c) => {
    const pct = c.max ? Math.round((c.score / c.max) * 100) : 0;
    return `<tr>
      <td>${c.code}. ${escapeHtml(c.name)}</td>
      <td>${c.methodLabel}</td>
      <td class="mono">${c.score} / ${c.max}</td>
      <td style="width:120px;"><div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;"></div></div></td>
    </tr>`;
  }).join('\n');
}

function allItemsHtml(categoryScores) {
  return categoryScores.map((c) => {
    const rows = c.items.map((it) => `<tr>
      <td class="mono">${it.no}</td>
      <td>${escapeHtml(it.text)}</td>
      <td class="mono">${it.score} / 2</td>
      <td>${escapeHtml(it.reason)}</td>
    </tr>`).join('\n');
    return `<h3 class="cat-heading">${c.code}. ${escapeHtml(c.name)} (${c.methodLabel})</h3>
    <table>
      <thead><tr><th>#</th><th>항목</th><th>점수</th><th>사유</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }).join('\n');
}

function top5Html(top5WithText) {
  if (!top5WithText.length) return '<p class="lead">우선순위 항목이 산출되지 않았습니다.</p>';
  return top5WithText.map((t, i) => `<div class="top5-item">
    <span class="top5-no mono">${i + 1}</span>
    <strong>${t.no}. ${escapeHtml(t.text || '')}</strong>
    <div class="score-sub">${escapeHtml(t.reason || '')}</div>
  </div>`).join('\n');
}

function contentSectionHtml({ packageTier, faqs, improvedCopy }) {
  if (packageTier === 'standard') return '';

  const faqHtml = (faqs || []).map((f) => `<div class="faq-item">
    <p class="faq-q">${escapeHtml(f.question)}</p>
    <p class="faq-a">${escapeHtml(f.answer)}</p>
  </div>`).join('\n');

  const copyHtml = improvedCopy
    ? `<h2>브랜드소개 문구 개선안</h2><div class="panel"><div class="copy-block">${escapeHtml(improvedCopy)}</div></div>`
    : '';

  return `
  <h2>FAQ·Q&A 콘텐츠 초안 (${(faqs || []).length}건)</h2>
  <div class="panel">${faqHtml || '<p class="lead">생성된 FAQ가 없습니다.</p>'}</div>
  ${copyHtml}`;
}

// 블로그 플랫폼(네이버 블로그 등)은 <head>/도메인 루트에 코드를 직접 심을 권한이 없는 경우가
// 많아, PREMIUM의 핵심 산출물(스키마·llms.txt)을 드려도 "받았는데 설치할 곳이 없는" 상황이
// 생길 수 있다. 코드는 그대로 제공하되, 어디에 어떻게 반영해야 하는지 안내를 덧붙인다.
function installGuidanceHtml({ platformHosted, adminAccess }) {
  if (!platformHosted && adminAccess !== '없음') return '';

  const lines = [];
  if (platformHosted) {
    lines.push('이 사이트는 네이버 블로그 등 제3자 플랫폼으로 판별되었습니다. 아래 코드는 도메인 루트/<head>에 직접 삽입하는 방식이라 플랫폼 기본 스킨에서는 설치가 불가능하거나 스킨의 "HTML 편집" 기능이 있어야 반영할 수 있습니다.');
  }
  if (adminAccess === '없음') {
    lines.push('설문에서 "사이트 관리자 권한 없음"으로 응답하셨습니다. 직접 설치가 어려우시면 아래 코드를 사이트 관리자·개발자에게 전달해 반영을 요청해 주세요.');
  }
  return `<div class="note-box">${lines.map(escapeHtml).join('<br>')}</div>`;
}

function snippetSectionHtml({ packageTier, snippets, platformHosted, adminAccess }) {
  if (packageTier !== 'premium' || !snippets) return '';
  return `
  <h2>FAQPage 스키마 마크업 (설치용 코드)</h2>
  ${installGuidanceHtml({ platformHosted, adminAccess })}
  <div class="panel"><pre class="snippet">${escapeHtml(snippets.faqSchemaHtml)}</pre></div>
  <h2>llms.txt (설치용 코드)</h2>
  <div class="panel"><pre class="snippet">${escapeHtml(snippets.llmsTxt)}</pre></div>`;
}

function siteTypeNoteHtml(platformHosted) {
  if (!platformHosted) return '';
  return '<p class="lead">판별 결과: 네이버 블로그 등 제3자 블로그 플랫폼 (도메인 루트 파일·헤드 스크립트 설치가 불가능한 항목은 평가에서 중립 처리됨)</p>';
}

function buildReportHtml({ intake, packageTier, allItems, top5, faqs, improvedCopy, snippets, platformHosted, adminAccess }) {
  // 템플릿 상단의 설명용 HTML 주석은 개발자 참고용이라 고객 전달본에는 남기지 않는다.
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8').replace(/<!--[\s\S]*?-->/g, '');
  const categoryScores = buildCategoryScores(allItems);
  const totalScore = categoryScores.reduce((sum, c) => sum + c.score, 0);
  const grade = gradeOf(totalScore);
  const packageLabel = PACKAGE_LABELS[packageTier] || packageTier;

  const allDefs = checklist.categories.flatMap((c) => c.items);
  const top5WithText = (top5 || []).map((t) => {
    const def = allDefs.find((i) => i.no === t.no);
    return { ...t, text: def ? def.text : '' };
  });

  const tokenMap = {
    CLIENT_BRAND: escapeHtml(intake.brandName || '브랜드'),
    PACKAGE_NAME: packageLabel,
    SITE_URL: escapeHtml(intake.url || ''),
    GENERATED_AT: new Date().toISOString().replace('T', ' ').slice(0, 19),
    TOTAL_SCORE: totalScore,
    MAX_SCORE: checklist.maxScore,
    GRADE: grade,
    GRADE_CLASS: `grade-${grade}`,
    CATEGORY_TABLE_ROWS: categoryTableRows(categoryScores),
    ALL_ITEMS_SECTION: allItemsHtml(categoryScores),
    TOP5_ROWS: top5Html(top5WithText),
    CONTENT_SECTION: contentSectionHtml({ packageTier, faqs, improvedCopy }),
    SNIPPET_SECTION: snippetSectionHtml({ packageTier, snippets, platformHosted, adminAccess }),
    SITE_TYPE_NOTE: siteTypeNoteHtml(platformHosted),
  };

  let html = template;
  for (const [key, value] of Object.entries(tokenMap)) {
    html = html.split(`{{${key}}}`).join(String(value));
  }

  return { html, totalScore, grade, categoryScores };
}

function writeReport({ intake, packageTier, allItems, top5, faqs, improvedCopy, snippets, platformHosted, adminAccess }, outputDir) {
  const { html, totalScore, grade, categoryScores } = buildReportHtml({ intake, packageTier, allItems, top5, faqs, improvedCopy, snippets, platformHosted, adminAccess });
  const safeBrand = (intake.brandName || 'client').replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
  const fileName = `report_${safeBrand}_${packageTier}_${Date.now()}.html`;
  const outputPath = path.join(outputDir, fileName);
  fs.writeFileSync(outputPath, html, 'utf-8');
  return { outputPath, fileName, totalScore, grade, categoryScores };
}

module.exports = { writeReport, buildReportHtml, buildCategoryScores, gradeOf, allItemsHtml };

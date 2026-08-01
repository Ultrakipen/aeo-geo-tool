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

function snippetSectionHtml({ packageTier, snippets }) {
  if (packageTier !== 'premium' || !snippets) return '';
  return `
  <h2>FAQPage 스키마 마크업 (설치용 코드)</h2>
  <div class="panel"><pre class="snippet">${escapeHtml(snippets.faqSchemaHtml)}</pre></div>
  <h2>llms.txt (설치용 코드)</h2>
  <div class="panel"><pre class="snippet">${escapeHtml(snippets.llmsTxt)}</pre></div>`;
}

function buildReportHtml({ intake, packageTier, allItems, top5, faqs, improvedCopy, snippets }) {
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
    TOP5_ROWS: top5Html(top5WithText),
    CONTENT_SECTION: contentSectionHtml({ packageTier, faqs, improvedCopy }),
    SNIPPET_SECTION: snippetSectionHtml({ packageTier, snippets }),
  };

  let html = template;
  for (const [key, value] of Object.entries(tokenMap)) {
    html = html.split(`{{${key}}}`).join(String(value));
  }

  return { html, totalScore, grade, categoryScores };
}

function writeReport({ intake, packageTier, allItems, top5, faqs, improvedCopy, snippets }, outputDir) {
  const { html, totalScore, grade, categoryScores } = buildReportHtml({ intake, packageTier, allItems, top5, faqs, improvedCopy, snippets });
  const safeBrand = (intake.brandName || 'client').replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
  const fileName = `report_${safeBrand}_${packageTier}_${Date.now()}.html`;
  const outputPath = path.join(outputDir, fileName);
  fs.writeFileSync(outputPath, html, 'utf-8');
  return { outputPath, fileName, totalScore, grade, categoryScores };
}

module.exports = { writeReport, buildReportHtml, buildCategoryScores, gradeOf };

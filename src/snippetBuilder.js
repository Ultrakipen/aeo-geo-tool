// PREMIUM 전용 산출물. SOP §5 템플릿(templates/faq-schema.html, templates/llms-txt.template)을
// 실제로 읽어서 그 구조를 그대로 재사용하되, 질문/답변 개수(N=10~15)에 맞게 동적으로 채운다.
const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

function summarize(text, max = 50) {
  const firstSentence = String(text || '').split(/[.!?]\s/)[0].trim();
  return firstSentence.length <= max ? firstSentence : `${firstSentence.slice(0, max)}...`;
}

// templates/faq-schema.html은 예시로 2개짜리 mainEntity를 담고 있다.
// 그 첫 항목을 "형태 청사진"으로 삼아 @type 등 구조를 그대로 복제하고, 실제 FAQ 개수만큼
// mainEntity 배열을 새로 만든다 — 템플릿과 코드를 분리 관리하면서도 하드코딩을 피하는 방식.
function buildFaqSchemaSnippet(faqs) {
  const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'faq-schema.html'), 'utf-8')
    .replace(/<!--[\s\S]*?-->/g, ''); // 상단 설명용 HTML 주석 제거 (주석 안 예시 텍스트가 매칭되는 것 방지)
  const match = raw.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('faq-schema.html 템플릿에서 JSON-LD 블록을 찾지 못했습니다.');

  const templateJson = JSON.parse(match[1]);
  const blueprint = templateJson.mainEntity[0];

  const mainEntity = faqs.map((f) => ({
    '@type': blueprint['@type'],
    name: f.question,
    acceptedAnswer: { '@type': blueprint.acceptedAnswer['@type'], text: f.answer },
  }));

  const schemaObject = {
    '@context': templateJson['@context'],
    '@type': templateJson['@type'],
    mainEntity,
  };

  return `<script type="application/ld+json">\n${JSON.stringify(schemaObject, null, 2)}\n</script>`;
}

// "## 헤더" 섹션 본문(다음 "## "가 나오기 전까지)을 newBody로 교체.
function replaceSection(text, header, newBody) {
  const lines = text.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === header);
  if (startIdx === -1) return text;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) { endIdx = i; break; }
  }
  const before = lines.slice(0, startIdx + 1);
  const after = lines.slice(endIdx);
  return [...before, newBody, '', ...after].join('\n');
}

function buildLlmsTxtSnippet({ intake, faqs }) {
  const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'llms-txt.template'), 'utf-8');

  const services = (intake.services && intake.services.length) ? intake.services : [intake.industry || '핵심 서비스'];
  const serviceLines = services
    .map((s) => `- ${s}: ${intake.differentiators ? `${intake.differentiators} 기반 제공` : '자세한 내용은 문의 바랍니다.'}`)
    .join('\n');

  const faqLines = faqs
    .slice(0, 5)
    .map((f) => `- ${f.question} → ${summarize(f.answer)}`)
    .join('\n');

  let out = raw;
  out = replaceSection(out, '## 주요 서비스', serviceLines);
  out = replaceSection(out, '## 자주 묻는 질문', faqLines);
  out = out
    .split('{브랜드명}').join(intake.brandName || '')
    .split('{한줄 브랜드 소개}').join(intake.brandIntro || intake.industry || '')
    .split('{브랜드 상세 소개 2~3문장}').join(intake.brandIntro || '')
    .split('{연락처 / 웹사이트}').join(intake.contactInfo || intake.url || '');

  return out;
}

function buildPremiumSnippets({ intake, faqs }) {
  return {
    faqSchemaHtml: buildFaqSchemaSnippet(faqs),
    llmsTxt: buildLlmsTxtSnippet({ intake, faqs }),
  };
}

module.exports = { buildFaqSchemaSnippet, buildLlmsTxtSnippet, buildPremiumSnippets };

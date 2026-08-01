// SOP §4 프롬프트 2(FAQ·Q&A 생성) + 프롬프트 3(브랜드소개 문구 개선) 호출.
// DELUXE=5건, PREMIUM=10~15건으로 N을 파라미터화한다 (SOP §4 "N은 호출 시 파라미터화").
const { loadPrompt, fillTemplate } = require('./promptLoader');
const { requestJSON } = require('./openaiClient');
const { getIndustryProfile } = require('./industryProfile');

const GENERATE_CONTENT_PROMPT = loadPrompt('generate-content.md');
const IMPROVE_COPY_PROMPT = loadPrompt('improve-copy.md');

// 실 API 호출 시 시스템 프롬프트에 덧붙일 업종별 안전 가드레일(있는 경우만).
// SOP §4 프롬프트 원문(GENERATE_CONTENT_PROMPT/IMPROVE_COPY_PROMPT)은 건드리지 않고,
// 그 위에 얹는 시스템 지침에만 추가한다.
function guardrailSuffix(industry) {
  const guardrail = getIndustryProfile(industry).contentGuardrail;
  return guardrail ? ` ${guardrail}` : '';
}

// 마지막 글자의 받침 유무로 조사를 고른다 — mock 질문 템플릿에 서비스명을 그대로 끼워 넣다 보면
// "부당해고 대응는"처럼 받침을 무시한 조사가 붙는 문제가 있어 만들었다.
function hasBatchim(word) {
  const ch = String(word || '').trim().slice(-1);
  const code = ch.charCodeAt(0);
  if (code < 0xAC00 || code > 0xD7A3) return false;
  return (code - 0xAC00) % 28 !== 0;
}

function josa(word, noBatchimForm, withBatchimForm) {
  return hasBatchim(word) ? withBatchimForm : noBatchimForm;
}

// {service:받침없음/받침있음} 토큰만 조사를 자동 선택하고, 나머지 {키}는 그대로 치환한다.
function fillAngleTemplate(template, service, ctx) {
  const withJosa = template.replace(/\{service:([^/}]+)\/([^}]+)\}/g, (_, noB, withB) => service + josa(service, noB, withB));
  return withJosa
    .split('{service}').join(service)
    .split('{brand}').join(ctx.brandName || '브랜드')
    .split('{industry}').join(ctx.industry || '해당 분야')
    .split('{target}').join(ctx.targetCustomer || '고객');
}

const QUESTION_ANGLES = [
  (s, ctx) => `${s}${josa(s, '는', '은')} 어떤 분들에게 추천되나요?`,
  (s, ctx) => `${s} 비용은 어떻게 책정되나요?`,
  (s, ctx) => `${ctx.brandName}의 ${s}${josa(s, '는', '은')} 다른 곳과 무엇이 다른가요?`,
  (s, ctx) => `${s}${josa(s, '를', '을')} 진행하기 전에 무엇을 준비해야 하나요?`,
  (s, ctx) => `${s} 관련 후기나 사례를 확인할 수 있나요?`,
  (s, ctx) => `${ctx.industry || '이 분야'}에서 ${ctx.brandName}${josa(ctx.brandName || '', '를', '을')} 선택해야 하는 이유는 무엇인가요?`,
  (s, ctx) => `${s}${josa(s, '는', '은')} 보통 얼마나 시간이 걸리나요?`,
  (s, ctx) => `${ctx.targetCustomer || '고객'}에게 ${s}${josa(s, '가', '이')} 어떻게 도움이 되나요?`,
];

function buildMockAnswer(question, service, ctx) {
  const diff = ctx.differentiators || '축적된 실무 경험';
  const industry = ctx.industry || '해당 분야';
  const target = ctx.targetCustomer || '고객';
  return [
    `${ctx.brandName}는 ${industry} 분야에서 ${diff}를 바탕으로 ${service}를 제공합니다.`,
    `${target}을 주요 대상으로 하며, 상담 과정에서 현재 상황과 목표를 먼저 확인한 뒤 진행 방식을 안내합니다.`,
    `정확한 비용·소요기간은 상담 시점의 조건에 따라 달라질 수 있어 개별 안내를 원칙으로 합니다.`,
  ].join(' ');
}

// 실 키 없이도 데모가 가능해야 하므로, 서비스 목록 × 질문 각도를 조합해 N개를 결정론적으로
// 채운다(입력이 같으면 항상 같은 결과). 서비스가 3개 미만이어도 각도를 돌려가며 N개를 채운다.
function buildMockFaqs(intake, n) {
  const services = (intake.services && intake.services.length) ? intake.services : [intake.industry || '핵심 서비스'];
  const ctx = { brandName: intake.brandName || '브랜드', industry: intake.industry, targetCustomer: intake.targetCustomer, differentiators: intake.differentiators };

  // 업종별 질문 각도(예: 쇼핑몰=배송/교환, 제조업B2B=MOQ/납기)를 일반 각도보다 먼저 채워
  // 업종 특화도가 높은 질문이 우선 노출되게 한다.
  const profile = getIndustryProfile(intake.industry);
  const industryAngleFns = (profile.extraFaqAngles || []).map((tpl) => (service, ctx2) => fillAngleTemplate(tpl, service, ctx2));
  const allAngles = [...industryAngleFns, ...QUESTION_ANGLES];

  const faqs = [];
  const seen = new Set();
  outer: for (let angleIdx = 0; angleIdx < allAngles.length; angleIdx += 1) {
    for (let svcIdx = 0; svcIdx < services.length; svcIdx += 1) {
      if (faqs.length >= n) break outer;
      const service = services[svcIdx];
      const question = allAngles[angleIdx](service, ctx);
      if (seen.has(question)) continue;
      seen.add(question);
      faqs.push({ question, answer: buildMockAnswer(question, service, ctx) });
    }
  }

  // 인테이크 설문 6번(고객이 자주 묻는 질문)을 실제 FAQ로 우선 반영하고 싶다면 앞쪽에 삽입.
  if (intake.faqQuestionsRaw) {
    const extra = String(intake.faqQuestionsRaw)
      .split(/[,\n]/)
      .map((q) => q.trim())
      .filter(Boolean)
      .slice(0, n);
    for (const q of extra) {
      if (faqs.length >= n) break;
      if (seen.has(q)) continue;
      seen.add(q);
      faqs.unshift({ question: q, answer: buildMockAnswer(q, services[0], ctx) });
    }
  }

  return faqs.slice(0, n);
}

async function generateFaqContent({ intake, n }) {
  const userPrompt = fillTemplate(GENERATE_CONTENT_PROMPT, {
    '업종': intake.industry || '',
    'N': n,
    '브랜드명': intake.brandName || '',
    '서비스1, 서비스2, 서비스3': (intake.services || []).join(', '),
    '타깃고객': intake.targetCustomer || '',
    '차별점': intake.differentiators || '',
    '설문 6번 답변': intake.faqQuestionsRaw || '',
  });

  const system = `당신은 AEO·GEO 콘텐츠 전문가입니다. 반드시 JSON으로만 답하세요. 스키마: {"faqs":[{"question":string,"answer":string}]} 정확히 ${n}개.${guardrailSuffix(intake.industry)}`;

  const { data, mode } = await requestJSON({
    system,
    user: userPrompt,
    mock: () => ({ faqs: buildMockFaqs(intake, n) }),
  });

  const faqs = Array.isArray(data.faqs) ? data.faqs.slice(0, n) : [];
  return { faqs, mode };
}

function buildMockImprovedCopy(intake, existingCopy) {
  const services = (intake.services && intake.services.length) ? intake.services.join('·') : '핵심 서비스';
  const diff = intake.differentiators || '실무 경험';
  const target = intake.targetCustomer || '고객';
  const base = `${intake.brandName || '브랜드'}는 ${intake.industry || '해당 분야'}에서 ${diff}를 바탕으로 ${services}를 제공합니다. 주요 대상은 ${target}이며, 과장된 홍보 문구 대신 확인 가능한 사실을 바탕으로 서비스를 안내합니다.`;
  if (!existingCopy) return base;
  // 원문 분량과 비슷하게 유지 — 원문 길이에 맞춰 문장을 덧붙이거나 자른다.
  if (base.length < existingCopy.length * 0.7) {
    return `${base} 문의 시 담당자가 상황에 맞는 진행 방식과 예상 절차를 구체적으로 안내합니다.`;
  }
  return base;
}

async function improveBrandCopy({ intake, existingCopy }) {
  const userPrompt = fillTemplate(IMPROVE_COPY_PROMPT, {
    '기존 소개문구': existingCopy || '',
  });

  const system = `당신은 AEO·GEO 카피라이팅 전문가입니다. 반드시 JSON으로만 답하세요. 스키마: {"improvedCopy":string}${guardrailSuffix(intake.industry)}`;

  const { data, mode } = await requestJSON({
    system,
    user: userPrompt,
    mock: () => ({ improvedCopy: buildMockImprovedCopy(intake, existingCopy) }),
  });

  return { improvedCopy: data.improvedCopy || '', mode };
}

module.exports = { generateFaqContent, improveBrandCopy };

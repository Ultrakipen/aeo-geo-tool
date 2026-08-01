// server.js와 cli.js가 공통으로 쓰는 오케스트레이터.
// siteFetcher → technicalChecker(A,B,E) + aiEvaluator(C,D,F) → (DELUXE/PREMIUM)contentGenerator
// → (PREMIUM)snippetBuilder 순서로 실행하고, 30항목을 합쳐 우선순위 Top5까지 계산한다.
const { fetchSite } = require('./siteFetcher');
const { runTechnicalChecks } = require('./technicalChecker');
const { evaluateWithAI } = require('./aiEvaluator');
const { generateFaqContent, improveBrandCopy } = require('./contentGenerator');
const { buildPremiumSnippets } = require('./snippetBuilder');
const checklist = require('../config/checklist.json');

// SOP §4: "N은 DELUXE=5, PREMIUM=10~15로 호출 시 파라미터화" — PREMIUM은 중간값인 12로 고정.
const FAQ_COUNT_BY_PACKAGE = { deluxe: 5, premium: 12 };

// 구글폼 필드명 규칙(SOP §2 "q1_url ~ q12_recheck_date")을 그대로 따르되,
// 3번 문항(브랜드명 및 한줄소개)은 코드에서 다루기 쉽도록 brand_name/brand_intro 두 필드로 나눈다.
function normalizeIntake(raw = {}) {
  const services = [raw.q4_service1, raw.q4_service2, raw.q4_service3]
    .map((s) => (s || '').trim())
    .filter(Boolean);

  return {
    url: (raw.q1_url || '').trim(),
    industry: (raw.q2_industry || '').trim(),
    brandName: (raw.q3_brand_name || '').trim(),
    brandIntro: (raw.q3_brand_intro || '').trim(),
    services,
    targetCustomer: (raw.q5_target_customer || '').trim(),
    faqQuestionsRaw: (raw.q6_faq_questions || '').trim(),
    competitors: (raw.q7_competitors || '').trim(),
    existingFaq: (raw.q8_existing_faq || '').trim(),
    differentiators: (raw.q9_differentiators || '').trim(),
    contactInfo: (raw.q10_contact_info || '').trim(),
    adminAccess: (raw.q11_admin_access || '').trim(),
    recheckDate: (raw.q12_recheck_date || '').trim(),
  };
}

// 프롬프트 1은 C/D/F만 채점하므로(원문 유지), 30항목 전체를 대상으로 한
// "우선순위 Top5"는 여기서 A~F 전체 점수를 낮은 순으로 다시 뽑아 계산한다.
function computeUnifiedTop5(allItems) {
  const defs = checklist.categories.flatMap((c) => c.items);
  const sorted = [...allItems].sort((a, b) => a.score - b.score || a.no - b.no);
  return sorted.slice(0, 5).map((it) => {
    const def = defs.find((d) => d.no === it.no);
    return { no: it.no, reason: it.reason, text: def ? def.text : '' };
  });
}

async function runDiagnosis({ intake, site }) {
  const technicalItems = runTechnicalChecks(site, intake);
  const aiResult = await evaluateWithAI({ site, intake });
  const allItems = [...technicalItems, ...aiResult.items];
  const top5 = computeUnifiedTop5(allItems);
  return { allItems, top5, aiMode: aiResult.mode, aiTop5: aiResult.top5 };
}

async function runContent({ intake, packageTier }) {
  const n = FAQ_COUNT_BY_PACKAGE[packageTier];
  if (!n) return null;
  const faqResult = await generateFaqContent({ intake, n });
  const copyResult = await improveBrandCopy({ intake, existingCopy: intake.brandIntro });
  return {
    faqs: faqResult.faqs,
    improvedCopy: copyResult.improvedCopy,
    mode: { faq: faqResult.mode, copy: copyResult.mode },
  };
}

// packageTier: 'standard' | 'deluxe' | 'premium'
// rawHtml이 주어지면(샘플 테스트) 네트워크 호출 없이 그 HTML을 진단 대상으로 쓴다.
async function runPipeline({ intake, packageTier, rawHtml }) {
  if (!['standard', 'deluxe', 'premium'].includes(packageTier)) {
    throw new Error(`알 수 없는 패키지: ${packageTier}`);
  }
  if (!rawHtml && !intake.url) {
    throw new Error('사이트 URL 또는 테스트용 HTML 중 하나는 필요합니다.');
  }

  const site = await fetchSite({ url: intake.url || undefined, rawHtml });
  const diagnosis = await runDiagnosis({ intake, site });

  let content = null;
  let snippets = null;
  if (packageTier === 'deluxe' || packageTier === 'premium') {
    content = await runContent({ intake, packageTier });
  }
  if (packageTier === 'premium' && content) {
    snippets = buildPremiumSnippets({ intake, faqs: content.faqs });
  }

  return {
    intake,
    packageTier,
    site,
    allItems: diagnosis.allItems,
    top5: diagnosis.top5,
    aiMode: diagnosis.aiMode,
    aiTop5: diagnosis.aiTop5,
    content,
    snippets,
  };
}

module.exports = { runPipeline, normalizeIntake, computeUnifiedTop5 };

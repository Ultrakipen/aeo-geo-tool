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

// 구글폼 응답자가 "example.com"처럼 프로토콜 없이 입력하는 경우가 흔해서,
// fetch()가 URL 파싱에 실패하지 않도록 여기서 https://를 자동으로 붙여준다.
function normalizeUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// 대시보드 수동 폼/샘플 데이터는 q4_service1~3 세 필드로 나눠서 보내지만,
// 실제 구글폼은 "최대3개,쉼표구분" 문항 하나뿐이라 Zap ① 웹훅은 q4_service 한 필드에
// 콤마로 합쳐서 보낸다 — 이 필드가 있으면 콤마 기준으로 나눠서 동일하게 처리한다.
function normalizeIntake(raw = {}) {
  const services = raw.q4_service
    ? raw.q4_service.split(',').map((s) => s.trim()).filter(Boolean)
    : [raw.q4_service1, raw.q4_service2, raw.q4_service3]
      .map((s) => (s || '').trim())
      .filter(Boolean);

  return {
    url: normalizeUrl(raw.q1_url),
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
    urlTypeSelfReport: (raw.q13_url_type || '').trim(),
  };
}

// URL 호스트네임 목록(BLOG_PLATFORM_HOSTS) 판별은 커스텀 도메인을 연결한 티스토리/워드프레스처럼
// 겉보기엔 홈페이지 같지만 실제로는 블로그 플랫폼인 경우를 놓친다 — 그래서 설문 13번 자기신고를
// 자동판별과 OR 조건으로 합쳐 어느 한쪽이라도 "블로그"라고 하면 중립 처리 대상으로 본다.
function isSelfReportedBlog(intake) {
  return /블로그/.test(intake.urlTypeSelfReport || '');
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

  const site = await fetchSite({ url: intake.url || undefined, rawHtml, selfReportBlog: isSelfReportedBlog(intake) });
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

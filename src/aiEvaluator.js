// SOP §4 프롬프트 1(diagnose.md) 호출 → 카테고리 C(브랜드 신뢰도), D(질문 대응력),
// F(AI 친화 문장 스타일) 채점. A/B/E는 technicalChecker.js가 담당하므로 여기서는 다루지 않는다.
const { loadPrompt, fillTemplate } = require('./promptLoader');
const { requestJSON } = require('./openaiClient');
const { getIndustryProfile } = require('./industryProfile');
const checklist = require('../config/checklist.json');

const DIAGNOSE_PROMPT = loadPrompt('diagnose.md');
// 실 API는 업종을 알아서 이해하므로 이 목록은 mock 모드(키 없이 데모할 때) 전용 보강 키워드다.
const BASE_EXPERTISE_KEYWORDS = ['자격증', '경력', '수상', '특허', '인증', '년 경력', '전문의', '박사'];

const AI_ITEM_NOS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 26, 27, 28, 29, 30];

// 예전엔 AI에게 항목 번호만 알려주고 각 번호가 무슨 기준인지(checklist.json의 text)는 전달하지
// 않았다 — 그 결과 모델이 카테고리 이름만 보고 15개 항목을 기억에 의존해 채점하다가, 13/15/16/
// 18/19/30번처럼 다른 카테고리의 근거 문구를 가져다 쓰는 사례가 실사용 중 발견됐다(예: "고객 후기·
// 사례 게재 여부"(13번) 항목에 "AI 친화적인 문장 구조가 전혀 나타나지 않는다"는 F카테고리용 사유가
// 붙는 식). checklist.json을 그대로 프롬프트에 박아 넣어 번호↔정의 매핑을 명시적으로 준다.
function buildItemDefinitions() {
  const defs = checklist.categories.flatMap((c) => c.items.map((it) => ({ ...it, categoryCode: c.code, categoryName: c.name })));
  const byCategory = new Map();
  for (const no of AI_ITEM_NOS) {
    const def = defs.find((d) => d.no === no);
    if (!def) continue;
    const key = `${def.categoryCode}. ${def.categoryName}`;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(`- ${def.no}. ${def.text}`);
  }
  return [...byCategory.entries()].map(([cat, lines]) => `${cat}\n${lines.join('\n')}`).join('\n\n');
}

const ITEM_DEFINITIONS = buildItemDefinitions();

const SYSTEM_PROMPT = [
  '당신은 AEO·GEO(생성형 AI 검색 노출) 진단 전문가입니다.',
  '반드시 아래 JSON 스키마로만 답하세요. 다른 텍스트는 포함하지 마세요.',
  '{"items":[{"no":11~15,20 중 하나,"score":0|1|2,"reason":"한 줄 근거"}], "top5":[{"no":number,"reason":"한 줄 근거"}]}',
  `items는 반드시 [${AI_ITEM_NOS.join(', ')}] 15개 번호를 모두 포함해야 하고, top5는 그 중 개선이 시급한 5개입니다.`,
  'reason은 반드시 사용자 메시지에 제시된 "평가 항목 목록"에서 그 no에 해당하는 항목 정의를 근거로 작성해야 하며, 다른 번호의 항목 정의나 다른 카테고리의 기준을 섞어 쓰면 안 됩니다.',
].join('\n');

function truncate(text, max = 6000) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}\n...(이하 생략)` : text;
}

function clampScore(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(2, Math.round(n)));
}

// 실 키 없이도 결과를 볼 수 있어야 하므로, 사이트 텍스트/인테이크 답변에서 관찰 가능한
// 키워드 신호를 바탕으로 결정론적 채점을 만든다(같은 입력 → 같은 결과, 데모 재현 가능).
function buildMockDiagnosis(site, intake) {
  const text = site.text || '';
  const has = (patterns) => patterns.some((p) => (p instanceof RegExp ? p.test(text) : text.includes(p)));
  const profile = getIndustryProfile(intake.industry);
  const expertiseKeywords = [...BASE_EXPERTISE_KEYWORDS, ...(profile.expertiseKeywords || [])];

  const items = [];
  const push = (no, score, reason) => items.push({ no, score: clampScore(score), reason });

  // C. 브랜드 신뢰도 신호
  const brandMentioned = intake.brandName ? text.includes(intake.brandName) : false;
  push(11, brandMentioned && text.length > 800 ? 2 : brandMentioned ? 1 : 0,
    brandMentioned ? '브랜드명이 본문에 등장하나 소개 분량으로 구체성 판단' : '본문에서 브랜드명을 확인하지 못함');
  push(12, has(expertiseKeywords) ? 2 : has(['전문']) ? 1 : 0,
    `전문성 근거(자격·경력·수상 등, ${intake.industry || '기타'} 업종 키워드 포함) 탐지 결과`);
  push(13, has(['후기', '리뷰', '고객 사례', '이용후기']) ? 2 : has(['사례']) ? 1 : 0,
    '고객 후기·사례 관련 키워드 탐지 결과');
  push(14, (intake.contactInfo && has(['전화', '연락처', '대표번호', '사업자등록번호', '주소'])) ? 2
    : has(['전화', '연락처', '주소']) ? 1 : 0,
    '연락처·사업자정보 노출 여부 탐지 결과');
  push(15, has(['보도', '언론', '방송', '수상', '협약', '인증기관']) ? 2 : 0,
    '외부 매체 언급·수상 등 제3자 신뢰 신호 탐지 결과');

  // D. 질문 대응력
  push(16, has(['추천']) ? 2 : 0, '"추천" 질문 대응 콘텐츠 신호 탐지 결과');
  push(17, has(['가격', '비용', '요금', '견적']) ? 2 : 0, '"비용·가격" 질문 대응 콘텐츠 신호 탐지 결과');
  push(18, has(['고르는 법', '선택 기준', '선택기준', '고르는법']) ? 2 : has(['비교']) ? 1 : 0,
    '"고르는 법·선택기준" 콘텐츠 신호 탐지 결과');
  push(19, has(['후기', '비교']) ? 2 : 0, '"후기·비교" 콘텐츠 신호 탐지 결과');
  const industryOrTarget = [intake.industry, intake.targetCustomer].filter(Boolean);
  const locationNote = profile.locationSensitive ? '' : ' (전국/온라인 대상 업종이라 지역보다 업종 특화 콘텐츠 여부 중심으로 평가)';
  push(20, industryOrTarget.some((k) => text.includes(k)) ? 2 : 1,
    `지역·업종 특화 질문 대응 콘텐츠 신호 탐지 결과${locationNote}`);

  // F. AI 친화 문장 스타일
  const exaggerationHits = (text.match(/(최고의|업계 1위|국내 최초|완벽한|무조건|100%\s?보장)/g) || []).length;
  push(26, exaggerationHits === 0 ? 2 : exaggerationHits <= 2 ? 1 : 0,
    `과장 표현 ${exaggerationHits}건 탐지 (적을수록 사실 기반 서술에 가까움)`);
  const sentences = text.split(/[.!?。]\s*/).filter((s) => s.trim().length > 0);
  const avgLen = sentences.length ? text.length / sentences.length : 0;
  push(27, avgLen > 0 && avgLen <= 60 ? 2 : avgLen <= 100 ? 1 : 0,
    `평균 문장 길이 약 ${Math.round(avgLen)}자 (짧을수록 한 문장 한 정보에 가까움)`);
  const parenHits = (text.match(/\([^)]{2,20}\)/g) || []).length;
  push(28, parenHits >= 3 ? 2 : parenHits >= 1 ? 1 : 0,
    `괄호 설명 병기 ${parenHits}건 탐지 (전문용어 설명 병기 추정치)`);
  const paragraphSignal = site.headings.h2.length + site.headings.h3.length;
  push(29, paragraphSignal >= 4 ? 2 : paragraphSignal >= 1 ? 1 : 0,
    `소제목 ${paragraphSignal}개로 단락 구분 (많을수록 단락당 정보 밀도 관리 추정)`);
  push(30, has(['작성자', '글쓴이', '저자', 'by ', 'Author']) ? 2 : 0,
    '작성자/저자 정보 표기 신호 탐지 결과');

  const priority = [...items].sort((a, b) => a.score - b.score || a.no - b.no).slice(0, 5);
  const top5 = priority.map((it) => ({ no: it.no, reason: it.reason }));

  return { items, top5 };
}

function normalizeDiagnosis(data) {
  const byNo = new Map();
  for (const raw of (data && data.items) || []) {
    const no = Number(raw.no);
    if (AI_ITEM_NOS.includes(no)) byNo.set(no, { no, score: clampScore(raw.score), reason: raw.reason || '' });
  }
  const items = AI_ITEM_NOS.map((no) => byNo.get(no) || { no, score: 0, reason: 'AI 응답에서 해당 항목 누락 — 0점 처리' });

  const top5Raw = (data && data.top5) || [];
  const top5 = top5Raw
    .map((t) => ({ no: Number(t.no), reason: t.reason || '' }))
    .filter((t) => AI_ITEM_NOS.includes(t.no));

  return { items, top5 };
}

async function evaluateWithAI({ site, intake }) {
  const brandName = intake.brandName || site.title || '브랜드명 미상';
  const userPrompt = fillTemplate(DIAGNOSE_PROMPT, {
    '브랜드명': brandName,
    '평가 항목 목록': ITEM_DEFINITIONS,
    '사이트 텍스트': truncate(site.text),
  });

  const { data, mode } = await requestJSON({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    mock: () => buildMockDiagnosis(site, intake),
  });

  const normalized = normalizeDiagnosis(data);
  return { items: normalized.items.map((it) => ({ ...it, method: 'ai' })), top5: normalized.top5, mode };
}

module.exports = { evaluateWithAI, AI_ITEM_NOS };

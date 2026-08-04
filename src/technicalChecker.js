// SOP §3 카테고리 A(기술적 요소), E(정보 구조·탐색성) — "자동점검 가능" —
// 그리고 B(콘텐츠 구조) — "일부 자동" — 를 siteFetcher가 수집한 HTML/텍스트만으로 채점한다.
// C, D, F는 사람이 읽어야 판단 가능한 정성 항목이라 aiEvaluator(프롬프트 1)가 담당한다.
const { getIndustryProfile } = require('./industryProfile');

const QUESTION_WORDS = /(무엇|어떻게|왜|얼마|언제|어디|누구|추천|비용|가격|방법|후기|비교|\?|？)/;
const DATE_PATTERN = /(20\d{2})[.\-년]\s?(\d{1,2})[.\-월]?/g;
// 병원·부동산 같은 로컬 비즈니스의 지역명 추출용. 완전한 행정구역 사전 대신 "○○시/도/구/군"
// 패턴만 잡는 실용적 휴리스틱 — 연락처(주소)에서 지역명 힌트를 뽑아낸다.
const REGION_HINT_PATTERN = /([가-힣]{2,4}(?:특별시|광역시|특별자치시|특별자치도|시|도|구|군))/;

function extractRegionHint(intake) {
  const match = String(intake.contactInfo || '').match(REGION_HINT_PATTERN);
  return match ? match[1] : null;
}

function countMatches(str, regex) {
  const matches = str.match(regex);
  return matches ? matches.length : 0;
}

function scoreThreshold(value, highMin, midMin) {
  if (value >= highMin) return 2;
  if (value >= midMin) return 1;
  return 0;
}

// 로컬 비즈니스(병원·부동산·지역매장 등)는 "서비스+지역명"이 둘 다 있어야 만점,
// 전국/온라인 대상 업종(쇼핑몰·제조업B2B·컨설팅 등)은 지역명 없다고 감점하지 않는다
// (industryKeywords.json의 locationSensitive 플래그로 판단).
function checkTitleKeyword(site, intake, profile) {
  const keywords = [intake.brandName, intake.industry, ...(intake.services || [])].filter(Boolean);
  const title = site.title || '';
  if (!title) return { no: 1, score: 0, reason: '메타 타이틀(<title>)이 비어 있음' };

  const hasServiceKeyword = keywords.some((k) => title.includes(k));

  if (!profile.locationSensitive) {
    if (hasServiceKeyword) return { no: 1, score: 2, reason: `타이틀에 핵심 서비스 키워드 포함 (전국/온라인 대상 업종이라 지역명 여부는 평가에서 제외): "${title}"` };
    return { no: 1, score: 1, reason: `타이틀은 있으나 서비스 키워드가 보이지 않음(전국/온라인 대상 업종): "${title}"` };
  }

  const regionHint = extractRegionHint(intake);
  const hasRegion = Boolean(regionHint && title.includes(regionHint));
  if (hasServiceKeyword && hasRegion) return { no: 1, score: 2, reason: `타이틀에 서비스·지역(${regionHint}) 키워드 모두 포함: "${title}"` };
  if (hasServiceKeyword) return { no: 1, score: 1, reason: `타이틀에 서비스 키워드는 있으나 지역명(${regionHint || '연락처에서 확인 안 됨'}) 미포함: "${title}"` };
  return { no: 1, score: 0, reason: `타이틀은 존재하나 서비스·업종·지역 키워드가 보이지 않음: "${title}"` };
}

function checkMetaDescription(site) {
  const desc = site.metaDescription || '';
  if (!desc) return { no: 2, score: 0, reason: '메타 디스크립션이 없음' };
  if (QUESTION_WORDS.test(desc)) return { no: 2, score: 2, reason: `질문형 요약 신호 확인: "${desc.slice(0, 60)}"` };
  return { no: 2, score: 1, reason: `디스크립션은 있으나 질문형 요약으로 보기 어려움: "${desc.slice(0, 60)}"` };
}

function checkFaqSchema(site) {
  if (site.hasFaqSchema) return { no: 3, score: 2, reason: 'FAQPage 스키마(JSON-LD) 확인됨' };
  // llms.txt/sitemap.xml과 같은 이유: 네이버 블로그 등 제3자 플랫폼 기본 스킨은
  // <head>에 커스텀 JSON-LD <script>를 넣을 권한을 고객에게 주지 않는 경우가 많다.
  if (site.llmsTxt.platformHosted) return { no: 3, score: 1, reason: '네이버 블로그 등 제3자 플랫폼은 <head>에 스키마 스크립트 삽입 권한이 없는 경우가 많아 해당 항목은 평가에서 제외(중립 처리)' };
  const hasAnyLdJson = /application\/ld\+json/i.test(site.html);
  if (hasAnyLdJson) return { no: 3, score: 1, reason: '구조화 데이터는 있으나 FAQPage 타입은 아님' };
  return { no: 3, score: 0, reason: 'FAQPage 스키마 마크업 없음' };
}

function checkLlmsTxt(site) {
  if (site.llmsTxt.platformHosted) return { no: 4, score: 1, reason: '네이버 블로그 등 제3자 플랫폼은 도메인 루트에 파일을 설치할 권한이 없어 해당 항목은 평가에서 제외(중립 처리)' };
  if (!site.llmsTxt.checked) return { no: 4, score: 1, reason: '도메인 확인 불가로 llms.txt 실측 불가(오프라인 테스트) — 실제 URL 진단 시 자동 확인' };
  if (site.llmsTxt.exists) return { no: 4, score: 2, reason: 'llms.txt 파일 확인됨' };
  return { no: 4, score: 0, reason: 'llms.txt 파일 없음' };
}

function checkSitemap(site) {
  if (site.sitemap.platformHosted) return { no: 5, score: 1, reason: '네이버 블로그 등 제3자 플랫폼은 도메인 루트에 파일을 설치할 권한이 없어 해당 항목은 평가에서 제외(중립 처리)' };
  if (!site.sitemap.checked) return { no: 5, score: 1, reason: '도메인 확인 불가로 sitemap.xml 실측 불가(오프라인 테스트) — 실제 URL 진단 시 자동 확인' };
  if (!site.sitemap.exists) return { no: 5, score: 0, reason: 'sitemap.xml 없음' };
  const lastmodMatches = site.sitemap.content.match(/<lastmod>(20\d{2}-\d{2}-\d{2})/g) || [];
  if (lastmodMatches.length === 0) return { no: 5, score: 1, reason: 'sitemap.xml은 있으나 lastmod 갱신 정보 없음' };
  const latestYear = Math.max(...lastmodMatches.map((m) => parseInt(m.match(/20\d{2}/)[0], 10)));
  const currentYear = new Date().getFullYear();
  if (currentYear - latestYear <= 1) return { no: 5, score: 2, reason: `sitemap.xml 최신화 확인됨 (최근 lastmod ${latestYear}년)` };
  return { no: 5, score: 1, reason: `sitemap.xml은 있으나 lastmod가 오래됨 (${latestYear}년)` };
}

function checkHeadingHierarchy(site) {
  const { h1, h2, h3 } = site.headings;
  const total = h1.length + h2.length + h3.length;
  if (total === 0) {
    // 완전 불가능(llms.txt 등)과 달리 네이버 블로그 에디터에도 "큰제목/중간제목/작은제목"
    // 스타일 버튼이 있어 블로거가 활용하면 개선 여지가 있다 — 감점은 유지하되 실행 가능한
    // 코칭 문구로 바꿔 "고칠 수 없는 걸 고치라"는 느낌을 주지 않는다.
    if (site.llmsTxt.platformHosted) {
      return { no: 6, score: 0, reason: '제목(H1~H3) 태그가 전혀 없음 — 네이버 블로그 등은 기본적으로 h태그를 안 붙이지만, 에디터의 "큰제목/중간제목/작은제목" 스타일을 본문에 적용하면 개선 가능' };
    }
    return { no: 6, score: 0, reason: '제목(H1~H3) 태그가 전혀 없음' };
  }
  const meaningful = [...h1, ...h2, ...h3].filter((h) => h.length >= 4).length;
  if (h1.length >= 1 && total >= 3 && meaningful >= Math.ceil(total * 0.6)) {
    return { no: 6, score: 2, reason: `제목 계층 ${total}개, 의미 있는 제목 ${meaningful}개로 구조화됨` };
  }
  return { no: 6, score: 1, reason: `제목 태그는 있으나(${total}개) 계층 구조가 약함` };
}

function checkFaqSection(site) {
  if (site.hasFaqSchema) return { no: 7, score: 2, reason: 'FAQPage 스키마 존재 = FAQ 섹션 확인' };
  const faqKeywordInText = /(자주\s?묻는\s?질문|FAQ|Q\s?&\s?A|질문과\s?답변)/i.test(site.text);
  const faqKeywordInHeading = [...site.headings.h1, ...site.headings.h2, ...site.headings.h3]
    .some((h) => /(자주\s?묻는\s?질문|FAQ|Q\s?&\s?A)/i.test(h));
  if (faqKeywordInHeading) return { no: 7, score: 2, reason: 'FAQ 관련 제목 발견' };
  if (faqKeywordInText) return { no: 7, score: 1, reason: '본문에 FAQ 관련 언급은 있으나 별도 섹션 여부 불확실' };
  return { no: 7, score: 0, reason: 'FAQ 섹션 신호 없음' };
}

function checkQnaRatio(site) {
  const questionCount = countMatches(site.text, /[?？]/g);
  const wordCount = Math.max(site.text.split(/\s+/).length, 1);
  const ratio = questionCount / wordCount;
  if (questionCount >= 3 && ratio >= 0.01) return { no: 8, score: 2, reason: `질문형 표현 ${questionCount}회 확인 (Q&A 콘텐츠 비중 양호)` };
  if (questionCount >= 1) return { no: 8, score: 1, reason: `질문형 표현 ${questionCount}회로 일부만 존재` };
  return { no: 8, score: 0, reason: 'Q&A 형식 콘텐츠 신호 없음' };
}

function checkBulletUsage(site) {
  const liCount = countMatches(site.html, /<li[\s>]/gi);
  return { no: 9, score: scoreThreshold(liCount, 6, 2), reason: `목록(<li>) 요소 ${liCount}개 발견` };
}

function checkFreshDate(site) {
  const matches = [...site.text.matchAll(DATE_PATTERN)];
  if (matches.length === 0) return { no: 10, score: 0, reason: '본문 내 날짜 표기 없음' };
  const years = matches.map((m) => parseInt(m[1], 10)).filter((y) => y >= 2000 && y <= 2100);
  if (years.length === 0) return { no: 10, score: 1, reason: '날짜 형식은 있으나 연도 인식 실패' };
  const latestYear = Math.max(...years);
  const currentYear = new Date().getFullYear();
  if (currentYear - latestYear <= 1) return { no: 10, score: 2, reason: `최근 날짜 표기 확인됨 (${latestYear}년)` };
  return { no: 10, score: 1, reason: `날짜 표기는 있으나 최신 정보로 보기 어려움 (${latestYear}년)` };
}

// 2026-08-03 세션엔 "블로그 스킨도 nav/breadcrumb를 기본으로 갖고 있는 경우가 많다"는
// 가정으로 #21/#22/#23을 중립 처리 대상에서 뺐지만, 실제 운영 중인 네이버 블로그(글 154개,
// 실제 카테고리 구조 존재)를 라이브 진단해보니 셋 다 0점으로 나왔다 — 카테고리·내부링크가
// 실제로 있어도 네이버가 <nav>/breadcrumb 클래스/크롤링 가능한 <a href> 같은 시맨틱 HTML을
// 안 써서 정규식 기반 자동점검으로는 신뢰성 있게 감지가 안 되는 것으로 확인됨. 이는 "권한이
// 없어 설치 불가능"(llms.txt류)과는 조금 다르지만, 블로거가 뭘 하든 이 자동점검 방식으로는
// 정당한 점수를 받을 수 없다는 점에서 결과적으로 같은 문제라 동일하게 중립 처리한다.
function checkInternalLinks(site) {
  if (site.llmsTxt.platformHosted) {
    return { no: 21, score: 1, reason: '네이버 블로그 등 제3자 플랫폼은 이웃글·카테고리 이동이 플랫폼 UI로 처리되어 본문 HTML만으로는 내부링크를 신뢰성 있게 셀 수 없어 해당 항목은 평가에서 제외(중립 처리)' };
  }
  return { no: 21, score: scoreThreshold(site.internalLinkCount, 8, 3), reason: `내부링크 추정 ${site.internalLinkCount}개` };
}

function checkMenuStructure(site) {
  if (site.llmsTxt.platformHosted) {
    return { no: 22, score: 1, reason: '네이버 블로그 등 제3자 플랫폼은 카테고리·메뉴가 플랫폼 공통 템플릿으로 제공되어(실제 카테고리가 있어도) 본문 HTML만으로는 구조를 신뢰성 있게 판별할 수 없어 해당 항목은 평가에서 제외(중립 처리)' };
  }
  const h2Count = site.headings.h2.length;
  if (site.hasNav && h2Count >= 2) return { no: 22, score: 2, reason: 'nav 메뉴 + 다수의 섹션 제목으로 카테고리 구조 확인' };
  if (site.hasNav || h2Count >= 1) return { no: 22, score: 1, reason: '메뉴 또는 섹션 구조가 부분적으로만 확인됨' };
  return { no: 22, score: 0, reason: '카테고리·메뉴 구조 신호 없음' };
}

function checkBreadcrumb(site) {
  if (site.llmsTxt.platformHosted) {
    return { no: 23, score: 1, reason: '네이버 블로그 등 제3자 플랫폼은 브레드크럼을 플랫폼이 자체 UI로 제공하거나 지원하지 않아 개인이 추가할 수 없는 경우가 많아 해당 항목은 평가에서 제외(중립 처리)' };
  }
  if (site.hasBreadcrumb) return { no: 23, score: 2, reason: '브레드크럼(BreadcrumbList 또는 breadcrumb 클래스) 확인됨' };
  return { no: 23, score: 0, reason: '브레드크럼 신호 없음' };
}

function checkPageSpeed(site) {
  if (site.responseTimeMs === null) {
    return { no: 24, score: 1, reason: '오프라인 테스트라 응답속도 실측 불가 — 실제 URL 진단 시 자동 측정' };
  }
  if (site.responseTimeMs <= 800) return { no: 24, score: 2, reason: `응답속도 ${site.responseTimeMs}ms로 양호` };
  if (site.responseTimeMs <= 2000) return { no: 24, score: 1, reason: `응답속도 ${site.responseTimeMs}ms로 보통` };
  return { no: 24, score: 0, reason: `응답속도 ${site.responseTimeMs}ms로 느림` };
}

function checkMobile(site) {
  if (site.viewportPresent) return { no: 25, score: 2, reason: 'viewport 메타 태그 확인됨 (모바일 대응)' };
  return { no: 25, score: 0, reason: 'viewport 메타 태그 없음 — 모바일 대응 미흡 가능성' };
}

// 카테고리 A, B, E — 스크립트로 채점 가능한 15항목.
function runTechnicalChecks(site, intake = {}) {
  const profile = getIndustryProfile(intake.industry);
  const items = [
    checkTitleKeyword(site, intake, profile),
    checkMetaDescription(site),
    checkFaqSchema(site),
    checkLlmsTxt(site),
    checkSitemap(site),
    checkHeadingHierarchy(site),
    checkFaqSection(site),
    checkQnaRatio(site),
    checkBulletUsage(site),
    checkFreshDate(site),
    checkInternalLinks(site),
    checkMenuStructure(site),
    checkBreadcrumb(site),
    checkPageSpeed(site),
    checkMobile(site),
  ];
  return items.map((item) => ({ ...item, method: 'auto' }));
}

module.exports = { runTechnicalChecks };

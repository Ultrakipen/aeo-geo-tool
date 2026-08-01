// 대시보드 서버(server.js)가 실제로 떠 있는 상태에서 진단→검수→내보내기 전체 흐름을
// HTTP 요청으로 왕복 검증하는 1회성 스크립트. 배포 코드가 아니라 이 저장소 완성 시점의
// 수동 QA 용도이며, npm 스크립트에는 등록하지 않는다.
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:4174';

async function main() {
  const rawHtml = fs.readFileSync(path.join(__dirname, '..', 'sample-data', 'sample-clinic.html'), 'utf-8');

  const form = new URLSearchParams({
    q1_url: '',
    rawHtml,
    q2_industry: '병원',
    q3_brand_name: '미소플러스치과',
    q3_brand_intro: '강남역 5번 출구 도보 3분',
    q4_service1: '임플란트',
    q4_service2: '치아교정',
    q4_service3: '스케일링',
    q5_target_customer: '강남 서초 지역 직장인',
    q9_differentiators: '원장 15년 임상 경력',
    q10_contact_info: '02-1234-5678',
    packageTier: 'premium',
  });

  const diagRes = await fetch(`${BASE}/diagnose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: form.toString(),
  });
  const diagHtml = await diagRes.text();
  console.log('[diagnose] status:', diagRes.status);
  const h1Match = diagHtml.match(/<h1>([^<]*)<\/h1>/);
  console.log('[diagnose] h1:', h1Match && h1Match[1]);
  const jobMatch = diagHtml.match(/action="\/export\/([^"]+)"/);
  console.log('[diagnose] jobId:', jobMatch && jobMatch[1]);
  const faqCountMatch = diagHtml.match(/name="faqCount" value="(\d+)"/);
  const faqCount = faqCountMatch ? parseInt(faqCountMatch[1], 10) : 0;
  console.log('[diagnose] faqCount:', faqCount);

  if (!jobMatch) {
    console.error('jobId를 찾지 못했습니다. diagnose 응답을 확인하세요.');
    process.exit(1);
  }

  const exportForm = new URLSearchParams();
  exportForm.set('faqCount', String(faqCount));
  for (let i = 0; i < faqCount; i += 1) {
    exportForm.set(`faq_q_${i}`, `[검수완료] 질문 ${i + 1}`);
    exportForm.set(`faq_a_${i}`, `[검수완료] 답변 ${i + 1} — 셀러가 직접 확인한 내용입니다.`);
  }
  exportForm.set('improvedCopy', '[검수완료] 셀러가 직접 다듬은 브랜드소개 문구입니다.');

  const exportRes = await fetch(`${BASE}/export/${jobMatch[1]}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: exportForm.toString(),
  });
  const exportHtml = await exportRes.text();
  console.log('\n[export] status:', exportRes.status);
  const files = [...exportHtml.matchAll(/href="\/output\/([^"]+)"/g)].map((m) => decodeURIComponent(m[1]));
  console.log('[export] files:', files);
  const msgMatch = exportHtml.match(/<textarea class="mono-area" readonly>([\s\S]*?)<\/textarea>/);
  console.log('[export] completionMessage snippet:', msgMatch && msgMatch[1].slice(0, 60));

  for (const f of files) {
    const filePath = path.join(__dirname, '..', 'output', f);
    if (!fs.existsSync(filePath)) {
      console.error(`누락된 산출물 파일: ${f}`);
      process.exit(1);
    }
  }

  const reportFile = files.find((f) => f.startsWith('report_'));
  const reportContent = fs.readFileSync(path.join(__dirname, '..', 'output', reportFile), 'utf-8');
  console.log('[export] report contains edited FAQ text:', reportContent.includes('[검수완료] 질문 1'));
  console.log('[export] report contains edited copy:', reportContent.includes('[검수완료] 셀러가 직접 다듬은'));

  const schemaFile = files.find((f) => f.startsWith('faq-schema_'));
  const schemaContent = fs.readFileSync(path.join(__dirname, '..', 'output', schemaFile), 'utf-8');
  console.log('[export] faq-schema contains edited question:', schemaContent.includes('[검수완료] 질문 1'));

  console.log('\nE2E 서버 테스트 성공');
}

main().catch((err) => {
  console.error('E2E 서버 테스트 실패:', err);
  process.exit(1);
});

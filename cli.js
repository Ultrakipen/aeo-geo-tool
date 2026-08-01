#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { runPipeline, normalizeIntake } = require('./src/pipeline');
const { writeReport } = require('./src/reportBuilder');
const { isMockMode } = require('./src/openaiClient');

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageTier = args.package || 'standard';
  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  let rawIntake = {};
  let rawHtml;

  // --sample=사이트1-저품질 형태로 sample-data/{name}.intake.json + {name}.html을 한번에 로드.
  if (args.sample) {
    const intakePath = path.join(__dirname, 'sample-data', `${args.sample}.intake.json`);
    const htmlPath = path.join(__dirname, 'sample-data', `${args.sample}.html`);
    rawIntake = JSON.parse(fs.readFileSync(intakePath, 'utf-8'));
    if (fs.existsSync(htmlPath)) rawHtml = fs.readFileSync(htmlPath, 'utf-8');
  } else if (args.intake) {
    rawIntake = JSON.parse(fs.readFileSync(path.resolve(args.intake), 'utf-8'));
  }

  if (args.html) rawHtml = fs.readFileSync(path.resolve(args.html), 'utf-8');

  const intake = normalizeIntake(rawIntake);
  if (args.url) intake.url = args.url;

  console.log(`\n[시작] 브랜드=${intake.brandName || '(미상)'} 패키지=${packageTier} AI모드=${isMockMode() ? 'mock' : 'live'} 대상=${intake.url || '(rawHtml)'}\n`);

  const result = await runPipeline({ intake, packageTier, rawHtml });

  const reportResult = writeReport({
    intake: result.intake,
    packageTier: result.packageTier,
    allItems: result.allItems,
    top5: result.top5,
    faqs: result.content ? result.content.faqs : null,
    improvedCopy: result.content ? result.content.improvedCopy : null,
    snippets: result.snippets,
  }, outputDir);

  console.log('[카테고리별 점수]');
  console.table(reportResult.categoryScores.map((c) => ({
    카테고리: `${c.code}. ${c.name}`,
    방식: c.methodLabel,
    점수: `${c.score} / ${c.max}`,
  })));
  console.log(`총점: ${reportResult.totalScore} / 60   등급: ${reportResult.grade}`);

  console.log('\n[개선 우선순위 Top5]');
  result.top5.forEach((t, i) => console.log(`${i + 1}. (${t.no}) ${t.text} — ${t.reason}`));

  if (result.content) {
    console.log(`\n[콘텐츠 생성] FAQ ${result.content.faqs.length}건 (faq=${result.content.mode.faq}, copy=${result.content.mode.copy})`);
  }
  if (result.snippets) {
    console.log('[코드 스니펫] FAQPage 스키마 + llms.txt 생성 완료 (리포트 내 포함)');
  }

  console.log(`\n[리포트 저장] ${reportResult.outputPath}`);
}

main().catch((err) => {
  console.error('[실패] 처리 중 오류 발생:', err.message);
  process.exit(1);
});

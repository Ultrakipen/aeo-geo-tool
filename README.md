# AEO·GEO 진단·콘텐츠 생성 엔진

크몽 상품 "기존 블로그·홈페이지 AI 검색(AEO·GEO) 노출 최적화 개선"의 주문 처리를
자동화하는 내부용 도구. `aeo-geo-order-fulfillment-sop.md` §9에서 제안한 구조를 그대로 구현했다.

## 왜 이렇게 만들었나

- 진단 체크리스트(30항목)·AI 프롬프트·코드 스니펫 템플릿은 `config/`, `prompts/`, `templates/`에
  텍스트 자산으로 분리해뒀다 — 문구를 바꾸고 싶으면 그 파일만 고치면 되고 `src/` 코드는 건드릴 필요가 없다.
- 30항목 중 자동으로 점검 가능한 A(기술적 요소)·E(정보 구조)·B(콘텐츠 구조, 일부 자동)는
  `src/technicalChecker.js`가 URL/HTML을 직접 파싱해 채점하고, 사람의 판단이 필요한
  C(브랜드 신뢰도)·D(질문 대응력)·F(AI 친화 문장 스타일)만 `src/aiEvaluator.js`가 ChatGPT API(프롬프트 1)를
  호출해 채점한다. 프롬프트 1 원문은 C/D/F만 다루므로(SOP §4 그대로 유지) 억지로 확장하지 않았다.
- `src/openaiClient.js`가 mock↔실연동 전환을 한곳에서 담당한다(automation-tool의 `src/adapters/`와
  동일한 패턴). `OPENAI_API_KEY`가 없으면 자동으로 mock으로 동작해 API 키·과금 없이 전체 파이프라인을
  끝까지 시연할 수 있다. 실 키를 `.env`에 넣기만 하면 코드 변경 없이 실제 OpenAI 호출로 전환된다.
- 크몽은 셀러용 API/웹훅을 제공하지 않고(SOP §1), 계정 자동로그인·주문 페이지 스크래핑은 이용약관
  위반 소지가 있어 이 도구의 범위에서 명시적으로 제외했다. `server.js`/`cli.js`는 "진단 실행 ~ 산출물
  생성 ~ 검수"까지만 담당하고, 주문 감지·실제 발송은 Zapier/Make(이메일 알림 감지 기반) 몫으로 남겨뒀다.
  `src/messenger.js`는 발송용 문구만 만들어줄 뿐 실제로 어디에도 전송하지 않는다.
- AI가 채점·생성한 결과는 정확도가 들쭉날쭉할 수 있어, 모든 티어에서 대시보드에 "검수" 화면을 두고
  사람이 확인·수정한 뒤에만 "내보내기"가 가능하도록 만들었다(SOP §8·§9 "검수 단계 생략 불가").
- 리포트는 `report-template.docx`/Google Docs API 대신 로컬 HTML 렌더링을 택했다(SOP §7 다이어그램이
  이미 언급한 대안). Google 인증 설정 없이 바로 동작하고, 브라우저에서 "인쇄 → PDF로 저장"하면 그대로
  고객 전달용 문서가 된다.

## 빠른 실행

```bash
npm install
npm run demo:standard   # 더미 병원 사이트로 STANDARD 전체 파이프라인 시연 (mock)
npm run demo:deluxe     # 같은 사이트로 DELUXE (FAQ·문구 5건 포함)
npm run demo:premium    # 같은 사이트로 PREMIUM (콘텐츠 12건 + 코드 스니펫)
npm run demo:liveurl    # 실제 URL(example.com)을 라이브로 fetch하는 경로 확인용
npm run dashboard       # 웹 대시보드 실행 → http://localhost:4174
```

`npm run demo:*`는 `sample-data/`의 더미 인테이크·HTML을 읽어 `output/`에 리포트(.html)를 생성하고
콘솔에 카테고리별 점수·등급·Top5·생성 콘텐츠 요약을 출력한다.

## mock ↔ 실 API 전환

기본값은 **mock 모드**다 — `OPENAI_API_KEY`가 없으면 `src/openaiClient.js`가 자동으로 결정론적
mock 응답(같은 입력이면 항상 같은 결과)을 대신 반환하므로, 실 키 없이도 진단·FAQ 생성·문구 개선·
코드 스니펫까지 전체 경로를 그대로 확인할 수 있다.

실 연동으로 전환하려면:

```bash
cp .env.example .env
# .env 파일을 열어 OPENAI_API_KEY=sk-... 값을 채운다
npm run dashboard
```

키를 넣는 순간 `aiEvaluator.js`(프롬프트 1)와 `contentGenerator.js`(프롬프트 2·3)가 자동으로
실제 OpenAI Chat Completions API를 호출하도록 바뀐다 — `src/` 코드는 한 줄도 바꿀 필요 없다.
`AEO_FORCE_MOCK=true`를 두면 실 키가 있어도 강제로 mock만 쓴다(리허설/데모 용도).

## 처리 흐름 (SOP §7·§8과 동일)

```
URL/설문답변 입력 → 패키지 선택
        │
        ▼
[진단] siteFetcher → technicalChecker(A,B,E 자동) + aiEvaluator(C,D,F, 프롬프트1)
        │
        ▼
[콘텐츠 생성] (DELUXE·PREMIUM만) contentGenerator(프롬프트2,3) → FAQ 5~12건 + 문구 개선안
        │
        ▼
[코드 스니펫] (PREMIUM만) snippetBuilder → FAQPage 스키마 + llms.txt (변수 치환 완료)
        │
        ▼
[검수 화면] ◀── 모든 티어 필수. FAQ·문구를 직접 수정 가능
        │
        ▼
"검수 완료 후 내보내기" → reportBuilder가 리포트(.html) + (PREMIUM)코드 스니펫 파일 생성
        │
        ▼
완료 전달 메시지(SOP §6 ③) 텍스트 표시 — 복사해서 수동 전달 (자동 발송 없음)
```

크몽 주문 감지·실제 메시지 발송은 이 도구의 범위 밖이며, Zapier/Make의 이메일 알림 감지
워크플로우에서 처리한다(SOP §1 제약).

## 웹훅 연동 (Zapier/Make → 자동 진단 실행)

사람이 대시보드 폼에 설문 답변을 직접 옮겨 적지 않아도 되도록 `POST /api/diagnose` 웹훅을 열어뒀다.
구글시트에 새 응답 행이 생기면 Zapier/Make가 그 값을 그대로 이 엔드포인트로 보내 진단을 자동 실행하고,
결과는 사람이 검수하러 들어올 수 있는 `reviewUrl`로 돌아온다. **검수·내보내기·실제 발송은 여전히
사람이 한다** — 이 웹훅은 "설문 제출 ~ 검수 대기" 구간만 자동화한다.

```bash
# .env에 WEBHOOK_TOKEN 설정 필요 (비워두면 503으로 막힘)
curl -X POST http://localhost:4174/api/diagnose \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "q1_url": "https://example.com",
    "q2_industry": "병원",
    "q3_brand_name": "미소플러스치과",
    "q3_brand_intro": "강남역 임플란트 전문",
    "q4_service1": "임플란트", "q4_service2": "치아교정", "q4_service3": "스케일링",
    "q5_target_customer": "강남 서초 지역 직장인",
    "q9_differentiators": "원장 15년 임상 경력",
    "q10_contact_info": "02-1234-5678",
    "packageTier": "premium"
  }'
```

응답:

```json
{
  "jobId": "1785...abc",
  "reviewUrl": "http://localhost:4174/review/1785...abc",
  "packageTier": "premium",
  "brandName": "미소플러스치과",
  "totalScore": 33,
  "maxScore": 60,
  "grade": "C",
  "aiMode": "mock"
}
```

**Zapier/Make 쪽 설정**: Trigger "구글시트 새 행" → Action "Webhooks by Zapier(POST)"로 위 JSON을
전송하고, 응답의 `reviewUrl`을 슬랙 메시지나 시트의 다른 컬럼에 다시 써넣어 "검수 대기: {{reviewUrl}}"
알림을 받도록 구성하면 된다.

**중요**: Zapier/Make는 클라우드 서비스라 `localhost`에는 접근할 수 없다. 실제로 연결하려면 이
대시보드를 외부에서 접근 가능한 곳(VPS, Render, Railway 등)에 배포해야 하고, 그 순간부터
`WEBHOOK_TOKEN`을 반드시 설정해야 한다(비워두면 엔드포인트가 항상 503을 반환해 막아준다).

## Render 배포

`render.yaml`이 이미 준비되어 있다 (Render Blueprint — 저장소를 연결하면 자동 인식).

1. GitHub에 이 저장소(`aeo-geo-tool/`)를 푸시
2. [render.com](https://render.com) 가입 → New → Blueprint → 방금 만든 저장소 선택
3. `render.yaml`을 자동 인식해 Web Service가 생성됨. 배포 전 환경변수 입력 화면에서
   `OPENAI_API_KEY`, `WEBHOOK_TOKEN` 값을 입력 (`sync: false`라 저장소에는 값이 남지 않음)
4. 배포 완료 후 `https://아무이름.onrender.com` 같은 실제 URL이 생김 — 이 주소를 Zapier/Make
   웹훅 URL로 사용 (`https://아무이름.onrender.com/api/diagnose`)

**무료 플랜 주의사항**: 15분 미사용 시 인스턴스가 슬립되고, 다음 요청이 오면 재시작된다. 재시작되면
서버 메모리는 초기화되지만, 검수 대기 중인 진단 작업은 `jobs/` 디렉토리에 파일로 저장되므로
`reviewUrl`은 재시작 후에도 그대로 열린다(`src/jobStore.js`). 단, **인스턴스 자체가 파일시스템을
포함해 완전히 새 디스크로 재배포되는 경우(코드 재배포, 플랜 변경 등)에는 `jobs/`와 `output/`의
내용도 함께 사라진다** — 이때는 검수·전달을 최대한 빨리 끝내고, 리포트는 다운로드해서 구글드라이브
등에 옮겨두는 걸 권장한다. 안정적인 영구 저장이 필요해지면 Render Disk(유료) 또는 S3 같은 외부
스토리지 연동을 추가로 검토.

## 파일 용도 구분

- `render.yaml` — Render Blueprint (배포 설정, 시크릿 값은 저장소에 남기지 않음)
- `config/checklist.json` — SOP §3 30항목 정의·배점기준·등급 구간
- `config/industryKeywords.json` — 업종별 mock 채점 키워드·지역 민감도·콘텐츠 가드레일·FAQ 질문 각도
- `prompts/*.md` — SOP §4 프롬프트 1·2·3 원문 (`{ }` 자리는 코드가 치환)
- `templates/faq-schema.html`, `templates/llms-txt.template` — SOP §5 코드 스니펫 원본 자산
  (`snippetBuilder.js`가 이 파일의 구조를 그대로 읽어 FAQ 개수만큼 동적으로 채운다)
- `templates/report-template.html` — 고객 전달용 리포트 템플릿(로컬 렌더링)
- `sample-data/sample-clinic.*` — 오프라인(rawHtml) 테스트용 더미 병원 사이트 + 인테이크 답변
- `sample-data/sample-shop.*` — 지역 무관 업종(쇼핑몰) 검증용 더미 사이트 + 인테이크 답변
- `sample-data/sample-legal.*` — 콘텐츠 가드레일 대상 업종(법률세무노무) 검증용 더미 사이트 + 인테이크 답변
- `sample-data/sample-liveurl.intake.json` — 실 URL(example.com) 라이브 fetch 경로 검증용
- `scripts/e2e-server-test.js` — `server.js`가 떠 있을 때 진단→검수(수정)→내보내기 전체 흐름을
  HTTP로 왕복 검증하는 수동 QA 스크립트 (npm 스크립트에는 등록하지 않음)
- `output/` — 생성된 리포트·코드 스니펫 파일 저장 위치
- `jobs/` — 검수 대기 중인 진단 작업 저장 위치(`src/jobStore.js`, 서버 재시작에도 검수 링크가
  살아있도록 파일로 보관 — git에는 커밋하지 않음)

## 업종 다양성 대응 (10개 업종 × 다양한 고객 환경)

SOP §2의 업종 10종(병원·부동산·학원·쇼핑몰·제조업B2B·프랜차이즈·컨설팅·법률세무노무·지역매장·기타)은
"지역 기반 오프라인 매장"부터 "전국 대상 온라인몰", "광고 규제가 있는 전문직"까지 성격이 크게 다르다.
체크리스트 30항목·프롬프트 원문은 SOP 그대로 업종 공통으로 유지하되, 아래 두 지점만
`config/industryKeywords.json`으로 업종별 차이를 흡수한다 — **새 업종을 추가하려면 이 파일에 항목만
추가하면 되고 `src/` 코드는 건드릴 필요가 없다** (checklist.json/prompts와 동일한 원칙).

- **`locationSensitive`** — 병원·부동산·지역매장처럼 로컬 비즈니스는 "서비스+지역명"이 타이틀에 있어야
  만점(§3 1번, 20번 항목)이지만, 쇼핑몰·제조업B2B·컨설팅처럼 전국/온라인 대상 업종은 지역명이 없다고
  감점하지 않는다. `technicalChecker.js`가 인테이크의 연락처(주소)에서 지역명을 추출해 실제 타이틀에
  포함됐는지 확인한다.
- **`expertiseKeywords`** — mock 모드(키 없이 데모할 때)의 전문성 신호 판별 키워드를 업종별로 보강한다
  (병원=전문의·임상경력, 법률세무노무=변호사·노무사, 쇼핑몰=KC인증·정품 등). 실 API를 쓰면 GPT가 업종을
  알아서 이해하므로 이건 mock 전용이다.
- **`contentGuardrail`** — 병원(의료법)·학원(과장광고)·프랜차이즈(가맹사업법)·법률세무노무(변호사법 등)처럼
  광고 규제가 있는 업종은 FAQ·문구 생성 시스템 프롬프트에 "결과를 확정적으로 보장하는 표현 금지" 지침을
  자동으로 덧붙인다. SOP §4 프롬프트 원문은 그대로 두고 그 위의 시스템 지침에만 얹는 방식이라 프롬프트
  자체는 훼손하지 않는다. 실 API로 `sample-legal`을 테스트한 결과 "개별 사안에 따라 달라질 수 있다"처럼
  결과를 단정하지 않는 문장으로 생성되는 것을 확인했다.
- **`extraFaqAngles`** — 업종별로 실제 고객이 물어볼 만한 질문 각도를 우선 채운다(쇼핑몰=배송/교환,
  제조업B2B=MOQ/납기, 법률세무노무=절차/수임료). mock 모드에서만 의미가 있고(실 API는 프롬프트만으로
  이미 업종을 반영), 서비스명에 조사(은/는 등)를 붙일 때 받침 유무를 자동 판별해 문법 오류
  ("대응는" 대신 "대응은")를 방지한다.

## 대시보드 사용법

1. `npm run dashboard` 실행 후 `http://localhost:4174` 접속
2. URL을 입력하거나(실 사이트 진단) 테스트용 HTML을 붙여넣고(오프라인 리허설), 인테이크 설문
   답변과 패키지(STANDARD/DELUXE/PREMIUM)를 선택 → "진단 실행"
3. 검수 화면에서 점수·등급·우선순위 Top5를 확인하고, DELUXE·PREMIUM은 생성된 FAQ·문구를
   직접 수정 가능
4. "검수 완료 후 내보내기" 클릭 → 리포트(.html)와 (PREMIUM) FAQ 스키마·llms.txt 파일 다운로드
   링크, 완료 전달 메시지(복사용)가 표시됨. 여기서 아무 것도 자동으로 발송되지 않는다.

## CLI 사용법 (배치·QA용)

```bash
node cli.js --sample=sample-clinic --package=premium      # 번들 샘플로 실행
node cli.js --url=https://example.com --package=standard   # 실 URL 진단
node cli.js --intake=path/to/intake.json --html=path/to/site.html --package=deluxe
```

`--intake`는 SOP §2 필드명(`q1_url` ~ `q12_recheck_date`, 단 3번 문항은 `q3_brand_name`/
`q3_brand_intro` 두 필드로 나눔) 그대로 담은 JSON 파일 경로.

## 실배포 시 추가로 해야 할 부분

- `.env`에 실제 `OPENAI_API_KEY` 등록 (현재는 기본값이 mock)
- Zapier/Make에서 "크몽 주문 알림 이메일 감지 → 설문 링크 발송(SOP §6 ①) → 구글시트 기록 →
  이 도구 호출(또는 결과 수동 업로드) → 완료 메시지 발송" 워크플로우 실제 구성
- 구글폼으로 §2 인테이크 설문 실제 게시, 필드명을 `q1_url` ~ `q12_recheck_date`로 통일
- `server.js`를 상시 운영한다면 업로드 인증(비밀번호/토큰) 추가 권장 — 현재는 로컬 전용 무인증 구조
- 리포트를 PDF로 고정 전달하고 싶다면 브라우저 인쇄 대신 헤드리스 브라우저(puppeteer 등)로
  HTML→PDF 변환 단계를 추가 (현재는 HTML 그대로 전달하거나 수동으로 PDF 저장)

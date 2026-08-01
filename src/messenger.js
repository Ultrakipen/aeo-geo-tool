// SOP §6 발송 메시지 템플릿 원문. 크몽은 셀러용 API/웹훅을 제공하지 않고(SOP §1 제약),
// 실제 발송은 이메일 알림 감지 기반 Zapier/Make 워크플로우의 몫이다(SOP §9).
// 이 모듈은 검수를 마친 뒤 셀러가 복사해서 보낼 "완성된 문구"만 만들어줄 뿐,
// 어디로도 자동 전송하지 않는다.

function fillTemplate(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(value === undefined || value === null ? '' : String(value));
  }
  return out;
}

const TEMPLATES = {
  orderReceived: `안녕하세요, {브랜드명}님. 주문해주셔서 감사합니다!
서비스 진행을 위해 아래 설문지를 작성해주시면 접수 후
{리드타임}일 이내 결과물을 전달드리겠습니다.
→ {설문 링크}`,

  reminder: `안녕하세요! 원활한 진행을 위해 설문지 작성이 필요합니다.
3분이면 작성 가능하며, 작성 완료 즉시 작업이 시작됩니다.
→ {설문 링크}`,

  completed: `{브랜드명}님, 요청하신 {패키지명}가 완료되어 전달드립니다.
결과물은 아래 링크에서 확인 가능합니다.

AI 검색·답변 알고리즘은 각 플랫폼에서 비공개로 운영되며
지속적으로 변경되어 특정 노출을 100% 보장드릴 수는 없는 점
양해 부탁드립니다. 추가 문의사항 있으시면 언제든 메시지 주세요.
→ {산출물 링크}`,
};

// SOP §8 목표 소요시간 표 기준 리드타임(일). 실제 값은 운영하며 조정 가능.
const LEAD_TIME_DAYS = { standard: 1, deluxe: 2, premium: 3 };
const PACKAGE_LABELS = { standard: 'STANDARD', deluxe: 'DELUXE', premium: 'PREMIUM' };

function buildOrderReceivedMessage({ brandName, surveyLink, packageTier }) {
  return fillTemplate(TEMPLATES.orderReceived, {
    '브랜드명': brandName,
    '리드타임': LEAD_TIME_DAYS[packageTier] || 3,
    '설문 링크': surveyLink,
  });
}

function buildReminderMessage({ surveyLink }) {
  return fillTemplate(TEMPLATES.reminder, { '설문 링크': surveyLink });
}

function buildCompletionMessage({ brandName, packageTier, deliverableLink }) {
  return fillTemplate(TEMPLATES.completed, {
    '브랜드명': brandName,
    '패키지명': PACKAGE_LABELS[packageTier] || packageTier,
    '산출물 링크': deliverableLink,
  });
}

module.exports = { buildOrderReceivedMessage, buildReminderMessage, buildCompletionMessage, TEMPLATES };

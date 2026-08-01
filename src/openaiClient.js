const fs = require('fs');
const path = require('path');

// 외부 dotenv 패키지 없이 .env를 읽는다. 이미 설정된 환경변수(예: 배포환경의 실제 값)는
// 덮어쓰지 않는다. 파일이 없으면 조용히 넘어간다(=기본 mock 모드로 동작).
function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// 실 키가 있어도 강제로 mock을 쓰고 싶을 때(리허설/데모)를 위한 탈출구.
const FORCE_MOCK = String(process.env.AEO_FORCE_MOCK || '').toLowerCase() === 'true';

function isMockMode() {
  return FORCE_MOCK || !OPENAI_API_KEY;
}

// system/user는 그대로 OpenAI Chat Completions에 실어 보낼 프롬프트 텍스트.
// mock은 실 키가 없을 때 대신 사용할 결정론적 JSON을 만드는 함수(호출부마다 다름).
// 실 연동 시에도 코드 변경 없이 이 함수 하나만 거치도록 해서, 채점/생성 로직(aiEvaluator,
// contentGenerator)은 mock/실연동 여부를 몰라도 되게 만든다.
async function requestJSON({ system, user, mock }) {
  if (isMockMode()) {
    return { data: await mock(), mode: 'mock' };
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI API 호출 실패 (${res.status}): ${errText.slice(0, 300)}`);
  }

  const json = await res.json();
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error('OpenAI 응답에 content가 없습니다.');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`OpenAI 응답 JSON 파싱 실패: ${err.message}`);
  }
  return { data: parsed, mode: 'live' };
}

module.exports = { requestJSON, isMockMode, OPENAI_MODEL };

// prompts/*.md 파일은 SOP §4 원문을 그대로 담고 있고, 위아래에 구현 참고용 HTML 주석이
// 붙어 있다. loadPrompt는 그 주석을 걷어내고 실제로 모델에 보낼 프롬프트 본문만 돌려준다.
const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

function loadPrompt(fileName) {
  const raw = fs.readFileSync(path.join(PROMPTS_DIR, fileName), 'utf-8');
  return raw.replace(/<!--[\s\S]*?-->/g, '').trim();
}

// 프롬프트 안의 {키} 자리를 값으로 치환. 값이 없으면 빈 문자열로 치환(요청 실패 방지).
function fillTemplate(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(value === undefined || value === null ? '' : String(value));
  }
  return out;
}

module.exports = { loadPrompt, fillTemplate };

// 외부 영구 저장소(Upstash Redis REST) — 검수 대기 작업(jobStore)과 산출물(output)을 여기에 저장한다.
// Render 무료 플랜은 인스턴스 슬립/재시작 시 로컬 디스크가 초기화되므로, 서버 재시작과 무관하게
// 살아있어야 하는 데이터는 반드시 이 모듈을 거쳐야 한다.
// 로컬 개발 시 UPSTASH_REDIS_REST_URL/TOKEN이 없으면 자동으로 로컬 파일(kv-data/)로 대체 동작한다.
const fs = require('fs');
const path = require('path');

const KV_URL = process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REMOTE = Boolean(KV_URL && KV_TOKEN);

const LOCAL_DIR = path.join(__dirname, '..', 'kv-data');
if (!USE_REMOTE && !fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });

function localPath(key) {
  return path.join(LOCAL_DIR, `${encodeURIComponent(key)}.json`);
}

// Upstash REST는 base URL로 POST하면서 body에 ["명령어", ...인자] 배열을 보내는 방식을 지원한다.
// GET/POST에 값을 URL 경로로 실어 보내는 방식은 리포트 HTML처럼 긴 값에서 URL 인코딩 문제가
// 생길 수 있어 피한다.
async function upstashCommand(commandArray) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commandArray),
  });
  if (!res.ok) throw new Error(`KV 요청 실패 (${res.status})`);
  return res.json();
}

async function kvSet(key, value) {
  const payload = JSON.stringify(value);
  if (USE_REMOTE) {
    await upstashCommand(['SET', key, payload]);
    return;
  }
  fs.writeFileSync(localPath(key), payload, 'utf-8');
}

async function kvGet(key) {
  if (USE_REMOTE) {
    const body = await upstashCommand(['GET', key]);
    return body.result == null ? null : JSON.parse(body.result);
  }
  const filePath = localPath(key);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

module.exports = { kvSet, kvGet, USE_REMOTE };

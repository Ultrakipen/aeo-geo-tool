// 검수 대기 중인 진단 작업을 파일로 저장한다. 메모리 Map이었을 때는 무료 호스팅
// 플랜의 유휴 시 프로세스 재시작(Render free tier의 15분 슬립 등)에서 검수 대기 중이던
// 작업이 통째로 사라지는 문제가 있었다 — 웹훅으로 진단이 생성된 직후 셀러가 바로 검수하지
// 않으면 reviewUrl이 깨지는 상황을 막기 위해 파일 기반으로 바꿨다.
const fs = require('fs');
const path = require('path');

const JOBS_DIR = path.join(__dirname, '..', 'jobs');
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

function jobPath(jobId) {
  return path.join(JOBS_DIR, `${jobId}.json`);
}

function saveJob(jobId, data) {
  fs.writeFileSync(jobPath(jobId), JSON.stringify(data), 'utf-8');
}

function loadJob(jobId) {
  const filePath = jobPath(jobId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

module.exports = { saveJob, loadJob, JOBS_DIR };

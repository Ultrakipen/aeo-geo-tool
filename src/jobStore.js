// 검수 대기 중인 진단 작업 저장 — kv.js(외부 영구 저장소)를 거치므로 Render 슬립/재시작에도 살아남는다.
const { kvGet, kvSet } = require('./kv');

async function saveJob(jobId, data) {
  await kvSet(`job:${jobId}`, data);
}

async function loadJob(jobId) {
  return kvGet(`job:${jobId}`);
}

module.exports = { saveJob, loadJob };

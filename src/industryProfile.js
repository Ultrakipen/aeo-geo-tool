// config/industryKeywords.json 조회 헬퍼. 목록에 없는 업종(또는 미입력)은 '기타' 프로필로 대체한다.
const industryKeywords = require('../config/industryKeywords.json');

const FALLBACK = industryKeywords['기타'];

function getIndustryProfile(industry) {
  return industryKeywords[industry] || FALLBACK;
}

module.exports = { getIndustryProfile };

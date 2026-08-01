// config/industryKeywords.json 조회 헬퍼. 목록에 없는 업종(또는 미입력)은 '기타' 프로필로 대체한다.
const industryKeywords = require('../config/industryKeywords.json');

const FALLBACK = industryKeywords['기타'];

// 구글폼 응답은 사람이 옵션 라벨을 직접 입력해 만들다 보니 "법률 세무 노무"처럼 띄어쓰기가
// 붙는 경우가 있다. 철자 자체가 다른 오타(예: 프렌차이즈)까지는 못 잡지만, 공백 차이 정도는
// 흡수해서 엉뚱하게 '기타'로 떨어지는 걸 막는다.
const NORMALIZED_LOOKUP = Object.keys(industryKeywords).reduce((acc, key) => {
  acc[key.replace(/\s+/g, '')] = key;
  return acc;
}, {});

function getIndustryProfile(industry) {
  const normalized = String(industry || '').replace(/\s+/g, '');
  const matchedKey = NORMALIZED_LOOKUP[normalized];
  return industryKeywords[matchedKey] || FALLBACK;
}

module.exports = { getIndustryProfile };

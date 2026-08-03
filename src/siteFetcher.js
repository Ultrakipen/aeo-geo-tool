// 대상 URL의 HTML/텍스트 수집. 실제 URL을 fetch하는 것이 기본 경로지만,
// 리허설/샘플 테스트에서는 인터넷 접속 중인 실제 도메인이 없는 더미 사이트도 다뤄야 하므로
// rawHtml(직접 넘긴 HTML 문자열)을 받으면 네트워크 호출 없이 그 내용을 그대로 분석 대상으로 쓴다.
// url이 함께 주어지면 llms.txt/sitemap.xml 존재 여부만 별도로 실제 확인을 시도한다(실패해도 무시).

const FETCH_TIMEOUT_MS = 15000;

// User-Agent가 없는 요청은 봇으로 간주해 차단하는 사이트(네이버 등)가 있어 실제 브라우저처럼 보이는
// 헤더를 붙인다 — 헤더 없이 fetch()만 쓰면 이런 사이트에서 응답 없이 계속 걸려있는(hang) 현상이 있었다.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
};

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: BROWSER_HEADERS });
    return { ok: res.ok, status: res.status, text: await res.text(), elapsedMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, status: 0, error: err.message, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

// 네이버 블로그·티스토리 등은 개인이 도메인 루트를 제어할 수 없어 llms.txt/sitemap.xml을
// 아예 설치할 권한이 없다 — 이런 곳에서 "없음"으로 감점하면 고객이 고칠 수 없는 걸 개선하라는
// 셈이 되므로, 루트 파일 확인 자체를 건너뛰고 별도로 표시한다.
const BLOG_PLATFORM_HOSTS = [
  'blog.naver.com', 'm.blog.naver.com', 'post.naver.com', 'blog.me',
  'tistory.com', 'brunch.co.kr', 'blogspot.com', 'medium.com',
];

function isBlogPlatformOrigin(origin) {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return BLOG_PLATFORM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch (err) {
    return false;
  }
}

// 도메인 없이 리허설용 부속파일(llms.txt, sitemap.xml)만 별도 확인.
async function probeAuxFile(origin, filePath) {
  if (!origin) return { exists: false, checked: false, platformHosted: false };
  try {
    const result = await fetchWithTimeout(`${origin}${filePath}`, 4000);
    return { exists: Boolean(result.ok && result.text && result.text.trim().length > 0), checked: true, platformHosted: false, content: result.ok ? result.text : '' };
  } catch (err) {
    return { exists: false, checked: false, platformHosted: false };
  }
}

function extractTag(html, regex) {
  const match = html.match(regex);
  return match ? match[1].trim() : '';
}

function extractAll(html, regex) {
  const out = [];
  let m;
  const re = new RegExp(regex, 'gi');
  while ((m = re.exec(html)) !== null) {
    out.push(m[1].replace(/<[^>]+>/g, '').trim());
  }
  return out;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function countInternalLinks(html, origin) {
  const hrefs = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  if (!origin) {
    // origin을 모르면(순수 rawHtml) 절대경로(다른 도메인)가 아닌 것만 내부링크로 간주
    return hrefs.filter((h) => h.startsWith('/') || h.startsWith('#') || !/^https?:\/\//i.test(h)).length;
  }
  return hrefs.filter((h) => h.startsWith('/') || h.startsWith('#') || h.includes(origin)).length;
}

function detectFaqSchema(html) {
  const scripts = extractAll(html.replace(/\n/g, ' '), '<script[^>]*type=["\']application/ld\\+json["\'][^>]*>([\\s\\S]*?)</script>');
  return scripts.some((block) => /FAQPage/i.test(block));
}

function detectBreadcrumb(html) {
  if (/BreadcrumbList/i.test(html)) return true;
  return /class=["'][^"']*breadcrumb[^"']*["']/i.test(html);
}

async function fetchSite({ url, rawHtml }) {
  let html;
  let mode;
  let responseTimeMs = null;
  let htmlSizeBytes = null;
  let origin = null;

  if (url) {
    try {
      origin = new URL(url).origin;
    } catch (err) {
      origin = null;
    }
  }

  if (rawHtml) {
    html = rawHtml;
    mode = 'raw';
    htmlSizeBytes = Buffer.byteLength(rawHtml, 'utf-8');
  } else {
    if (!url) throw new Error('siteFetcher: url 또는 rawHtml 중 하나는 필요합니다.');
    const result = await fetchWithTimeout(url);
    if (!result.ok) {
      throw new Error(`사이트 응답 실패: ${url} (${result.error || `HTTP ${result.status}`})`);
    }
    html = result.text;
    mode = 'live';
    responseTimeMs = result.elapsedMs;
    htmlSizeBytes = Buffer.byteLength(html, 'utf-8');
  }

  const platformHosted = isBlogPlatformOrigin(origin);
  const platformHostedResult = { exists: false, checked: false, platformHosted: true };
  const [llmsTxt, sitemap] = platformHosted
    ? [platformHostedResult, platformHostedResult]
    : await Promise.all([
    probeAuxFile(origin, '/llms.txt'),
    probeAuxFile(origin, '/sitemap.xml'),
  ]);

  const title = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription = extractTag(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
    || extractTag(html, /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);
  const viewportPresent = /<meta[^>]+name=["']viewport["']/i.test(html);

  const headings = {
    h1: extractAll(html, '<h1[^>]*>([\\s\\S]*?)</h1>'),
    h2: extractAll(html, '<h2[^>]*>([\\s\\S]*?)</h2>'),
    h3: extractAll(html, '<h3[^>]*>([\\s\\S]*?)</h3>'),
  };

  const text = stripHtml(html);

  return {
    url: url || null,
    origin,
    mode,
    fetchedAt: new Date().toISOString(),
    html,
    text,
    title,
    metaDescription,
    headings,
    hasFaqSchema: detectFaqSchema(html),
    hasBreadcrumb: detectBreadcrumb(html),
    hasNav: /<nav[\s>]/i.test(html),
    viewportPresent,
    internalLinkCount: countInternalLinks(html, origin),
    llmsTxt,
    sitemap,
    responseTimeMs,
    htmlSizeBytes,
  };
}

module.exports = { fetchSite, stripHtml };

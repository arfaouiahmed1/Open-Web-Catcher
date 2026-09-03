import { isChromeErrorPage } from '../../shared/error-codes.js';

const CHALLENGE_SIGNATURES = [
  /cloudflare/i,
  /turnstile/i,
  /cf-challenge/i,
  /ddos-guard/i,
  /hcaptcha/i,
  /recaptcha/i,
  /interstitial/i,
  /checking your browser/i,
  /just a moment/i,
  /verify you are human/i,
  /security verification/i,
  /attention required/i,
];

const BLOCK_SIGNATURES = [
  /403 forbidden/i,
  /access denied/i,
  /429 too many requests/i,
  /rate limit exceeded/i,
  /geo-blocked/i,
  /not available in your region/i,
  /ip address has been banned/i,
];

/**
 * Detect the current access state of a page.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<'open'|'challenge'|'blocked'|'error'|'loading'>}
 */
export async function detectAccessState(page) {
  if (!page || page.isClosed()) return 'error';

  let currentUrl = '';
  try {
    currentUrl = page.url() || '';
  } catch {
    return 'error';
  }

  // 1. Chrome error page
  if (isChromeErrorPage(currentUrl)) {
    return 'error';
  }

  // 2. Check readyState
  try {
    const readyState = await page.evaluate(() => document.readyState).catch(() => 'loading');
    if (readyState === 'loading') {
      return 'loading';
    }
  } catch {
    // Evaluation failed; page might be navigating
    return 'loading';
  }

  // 3. Scan title and body text for challenges / blocks
  try {
    const { title, bodySnippet } = await page.evaluate(() => {
      const titleText = document.title || '';
      const bodyText = (document.body?.innerText || '').slice(0, 2000);
      return { title: titleText, bodySnippet: bodyText };
    }).catch(() => ({ title: '', bodySnippet: '' }));

    const combinedText = `${title} ${bodySnippet}`;

    // Check for challenge signatures
    for (const pattern of CHALLENGE_SIGNATURES) {
      if (pattern.test(combinedText)) {
        return 'challenge';
      }
    }

    // Check for challenge iframes (e.g. Cloudflare challenge frame)
    const frames = page.frames();
    for (const frame of frames) {
      const frameUrl = frame.url() || '';
      if (
        frameUrl.includes('challenges.cloudflare.com') ||
        frameUrl.includes('recaptcha') ||
        frameUrl.includes('hcaptcha.com') ||
        frameUrl.includes('turnstile')
      ) {
        return 'challenge';
      }
    }

    // Check for explicit block signatures
    for (const pattern of BLOCK_SIGNATURES) {
      if (pattern.test(combinedText)) {
        return 'blocked';
      }
    }
  } catch {
    // If text evaluation throws, assume still loading
    return 'loading';
  }

  return 'open';
}

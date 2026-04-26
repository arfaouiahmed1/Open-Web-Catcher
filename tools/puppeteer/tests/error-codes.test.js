import assert from 'node:assert/strict';

import {
  classifyChromeError,
  classifyIframeFailure,
  extractChromeNetErrorCode,
  summarizeRetryAttempts,
} from '../../shared/error-codes.js';

assert.equal(extractChromeNetErrorCode('Navigation failed with net::ERR_NETWORK'), 'ERR_NETWORK');

const transientError = classifyChromeError('Navigation failed with net::ERR_FAILED');
assert.equal(transientError.error_category, 'transient');
assert.equal(transientError.max_retries, 4);

const permanentError = classifyChromeError('Navigation failed with net::ERR_BLOCKED_BY_CLIENT');
assert.equal(permanentError.error_category, 'permanent');
assert.equal(permanentError.max_retries, 0);

const chromeErrorPage = classifyChromeError({ message: 'Navigation ended on browser error page', url: 'chrome-error://chromewebdata/' });
assert.equal(chromeErrorPage.error_code, 'CHROME_ERROR_PAGE');
assert.equal(chromeErrorPage.error_category, 'transient');

const iframeSandbox = classifyIframeFailure({
  errorText: 'Blocked by sandbox: missing allow-scripts',
  resourceType: 'sub_frame',
});
assert.equal(iframeSandbox.detection_reason, 'sandbox');
assert.equal(iframeSandbox.recoverable, true);

const iframeXfo = classifyIframeFailure({
  errorText: 'net::ERR_BLOCKED_BY_RESPONSE (x-frame-options)',
  resourceType: 'sub_frame',
});
assert.equal(iframeXfo.detection_reason, 'x_frame_options');
assert.equal(iframeXfo.recoverable, false);

const summary = summarizeRetryAttempts([
  { error_category: 'transient', chrome_error_page: false },
  { error_category: 'transient', chrome_error_page: true },
  { error_category: 'permanent', chrome_error_page: false },
]);
assert.equal(summary.transient_attempts, 2);
assert.equal(summary.permanent_failures, 1);
assert.equal(summary.chrome_error_page_failures, 1);

console.log('Validated shared Chrome error classification helpers.');

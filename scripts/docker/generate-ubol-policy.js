const fs = require('node:fs');

const extensionId = 'ddkjiahejlhfcafbddmgiahcphecmpfh';
const extensionDir = String(process.env.OWC_UBOL_EXTENSION_DIR || '').trim();
const rulesetDetailsPath = String(
  process.env.OWC_UBOL_RULESET_DETAILS_PATH
  || (extensionDir ? `${extensionDir}/rulesets/ruleset-details.json` : ''),
).trim();
const defaultFilteringRaw = String(process.env.OWC_UBOL_DEFAULT_FILTERING || 'optimal').trim().toLowerCase();
const validModes = new Set(['none', 'basic', 'optimal', 'complete']);
const defaultFiltering = validModes.has(defaultFilteringRaw) ? defaultFilteringRaw : 'optimal';
const allowlistHosts = String(process.env.OWC_ADBLOCK_ALLOWLIST_HOSTS || '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

if (!rulesetDetailsPath || !fs.existsSync(rulesetDetailsPath)) {
  console.log(`[entrypoint] uBOL ruleset details missing at ${rulesetDetailsPath || '<unset>'}; skipping policy generation.`);
  process.exit(0);
}

const parsed = JSON.parse(fs.readFileSync(rulesetDetailsPath, 'utf8'));
const ruleIds = Array.from(new Set(
  (Array.isArray(parsed) ? parsed : [])
    .map((entry) => (entry && typeof entry.id === 'string' ? entry.id.trim() : ''))
    .filter(Boolean),
));

const policy = {
  '3rdparty': {
    extensions: {
      [extensionId]: {
        defaultFiltering,
        disableFirstRunPage: true,
        strictBlockMode: true,
        showBlockedCount: true,
        rulesets: ['-*', '+default', ...ruleIds.map((id) => `+${id}`)],
        ...(allowlistHosts.length ? { noFiltering: allowlistHosts } : {}),
      },
    },
  },
};

const payload = `${JSON.stringify(policy, null, 2)}\n`;
for (const destination of [
  '/etc/opt/chrome/policies/managed/ubol.json',
  '/etc/chromium/policies/managed/ubol.json',
]) {
  fs.mkdirSync(destination.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(destination, payload, 'utf8');
}

console.log(`[entrypoint] Generated uBOL managed policy with ${ruleIds.length} rulesets (mode=${defaultFiltering}).`);

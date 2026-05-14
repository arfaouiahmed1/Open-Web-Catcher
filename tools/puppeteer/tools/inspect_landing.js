import { inspect } from "./inspect.js";

const HOSTING_PATTERN =
  /(watch|live|stream|match|fixture|event|game|player|embed|server|channel|vs|versus|kickoff|league|cup|sports?)/i;
const NOISE_PATTERN =
  /(login|sign in|signup|register|privacy|terms|cookie|contact|about|help|faq|telegram|discord|twitter|facebook|instagram|whatsapp|tiktok|youtube)/i;

const normalizeWhitespace = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

function normalizeDomain(url) {
  try {
    const domain = new URL(String(url || "")).hostname.toLowerCase();
    return domain.startsWith("www.") ? domain.slice(4) : domain;
  } catch {
    return "";
  }
}

function inferMetadata(text, url) {
  const normalized = normalizeWhitespace(text);
  const metadata = {
    participants: null,
    status: /\blive\b/i.test(normalized)
      ? "live"
      : /replay|vod/i.test(normalized)
        ? "replay"
        : /upcoming|soon|today|tomorrow/i.test(normalized)
          ? "upcoming"
          : "unknown",
    scheduled_time: null,
    channel: null,
    competition: null,
  };

  const participantsMatch = normalized.match(
    /([\w .'-]{2,})\s+(?:vs|v|versus)\s+([\w .'-]{2,})/i,
  );
  if (participantsMatch) {
    metadata.participants = `${normalizeWhitespace(participantsMatch[1])} vs ${normalizeWhitespace(participantsMatch[2])}`;
  }

  const timeMatch = normalized.match(/\b(\d{1,2}:\d{2}\s?(?:am|pm)?)\b/i);
  if (timeMatch) {
    metadata.scheduled_time = timeMatch[1].toUpperCase();
  }

  const channelMatch = normalized.match(
    /(?:channel|tv)\s*[:\-]?\s*([\w .'-]{2,80})/i,
  );
  if (channelMatch) {
    metadata.channel = normalizeWhitespace(channelMatch[1]);
  }

  const competitionMatch = normalized.match(
    /(?:league|cup|championship|tournament)\s*[:\-]?\s*([\w .'-]{2,120})/i,
  );
  if (competitionMatch) {
    metadata.competition = normalizeWhitespace(competitionMatch[1]);
  }

  if (!metadata.channel && /channel|tv/i.test(url || "")) {
    metadata.channel = "possible_channel_link";
  }

  return metadata;
}

function candidateScore(candidate) {
  const haystack = `${candidate.text} ${candidate.url}`.toLowerCase();
  let score = 0;
  if (HOSTING_PATTERN.test(haystack)) score += 8;
  if (/\b(vs|versus)\b/.test(haystack)) score += 6;
  if (/\blive\b/.test(haystack)) score += 5;
  if (/watch|play|stream/.test(haystack)) score += 4;
  if (candidate.metadata?.participants) score += 4;
  if (candidate.same_origin) score += 2;
  return score;
}

function toCandidate(link, pageUrl) {
  const url = link.href || link.url || "";
  const text = normalizeWhitespace(
    link.text || link.ancestor_text_preview || "",
  );
  const metadata = inferMetadata(text, url);
  return {
    url,
    text,
    selector: link.selector || "",
    xpath: link.xpath || "",
    x: Math.round(link.bbox?.x || link.x || 0),
    y: Math.round(link.bbox?.y || link.y || 0),
    width: Math.round(link.bbox?.width || link.width || 0),
    height: Math.round(link.bbox?.height || link.height || 0),
    frame_path: link.frame_path || "root",
    region_selector: link.region_selector || "",
    same_origin: normalizeDomain(url) === normalizeDomain(pageUrl),
    metadata,
    relevance_score: 0,
  };
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = String(item.url || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function inspectLanding(params = {}) {
  const data = await inspect({
    ...params,
    scanMode: "landing",
    max_depth: params.max_depth ?? 6,
    max_children_per_node: params.max_children_per_node ?? 40,
    max_links: params.max_links ?? 320,
    max_interactive_elements: params.max_interactive_elements ?? 280,
    max_images: params.max_images ?? 140,
    max_sources: params.max_sources ?? 140,
    max_forms: params.max_forms ?? 20,
    max_form_inputs: params.max_form_inputs ?? 24,
    max_table_rows: params.max_table_rows ?? 40,
    max_frames: params.max_frames ?? 10,
    frame_eval_timeout_ms: params.frame_eval_timeout_ms ?? 7000,
    include_network: params.include_network ?? false,
    include_response_bodies: params.include_response_bodies ?? false,
    include_frames: params.include_frames ?? false,
  });

  const allLinks = Array.isArray(data.links) ? data.links : [];
  const hosting_candidate_links = dedupeByUrl(
    allLinks
      .map((link) => toCandidate(link, data.url || data.page?.final_url || ""))
      .filter((entry) => entry.url && !entry.url.startsWith("javascript:"))
      .filter((entry) => !NOISE_PATTERN.test(`${entry.text} ${entry.url}`))
      .map((entry) => ({ ...entry, relevance_score: candidateScore(entry) }))
      .sort((a, b) => b.relevance_score - a.relevance_score),
  );

  const candidateDomains = [];
  const seenDomains = new Set();
  for (const entry of hosting_candidate_links) {
    const domain = normalizeDomain(entry.url);
    if (!domain || seenDomains.has(domain)) continue;
    seenDomains.add(domain);
    candidateDomains.push(domain);
  }

  return {
    ...data,
    context_type: "landing",
    inspect_profile: "landing",
    focus: {
      primary: ["metadata", "links"],
      minimized: ["network", "frames"],
    },
    hosting_candidate_links,
    landing_summary: {
      total_links: allLinks.length,
      hosting_candidate_count: hosting_candidate_links.length,
      same_origin_candidates: hosting_candidate_links.filter(
        (entry) => entry.same_origin,
      ).length,
      third_party_candidates: hosting_candidate_links.filter(
        (entry) => !entry.same_origin,
      ).length,
      candidate_domains: candidateDomains,
    },
  };
}

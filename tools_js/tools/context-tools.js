import {
  augmentElements,
  buildEnvelope,
  buildFrameState,
  buildFrameTree,
  collectElements,
  filterElements,
  getMediaSummary,
  readElementDetail,
  withBrowserSession,
} from '../shared/tool-runtime.js';

function summarizeKinds(elements) {
  const counts = {};
  for (const element of elements) {
    counts[element.kind] = (counts[element.kind] || 0) + 1;
  }
  return counts;
}

function compactElements(elements, limit = 8) {
  return elements.slice(0, limit).map((element) => ({
    kind: element.kind,
    text: element.text,
    href: element.href,
    src: element.src,
    selector: element.selector,
    xpath: element.xpath,
    frame_path: element.frame_path,
    geometry: element.geometry,
    element_ref: element.element_ref,
  }));
}

function summarizePagination(elements) {
  const paginationMatches = elements.filter((element) =>
    element.kind === 'link'
    && (
      /next|prev|page|\d+/.test((element.text || '').toLowerCase())
      || /pagination|page/.test(element.selector || '')
    ));

  return {
    detected: paginationMatches.length > 0,
    candidates: compactElements(paginationMatches, 6),
  };
}

function summarizeForms(elements) {
  const forms = elements.filter((element) => element.kind === 'form');
  const inputs = elements.filter((element) => ['input', 'checkbox', 'radio', 'select'].includes(element.kind));
  return {
    form_count: forms.length,
    input_count: inputs.length,
    top_forms: compactElements(forms, 4),
    top_inputs: compactElements(inputs, 6),
  };
}

export async function getPageContext({
  frame_path = 'root',
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const frameState = await buildFrameState(page, frame_path);
    if (!frameState.ok) {
      return buildEnvelope(page, {
        frame_path,
        ok: false,
        error: frameState.error,
        data: { frame_tree: await buildFrameTree(page) },
      });
    }

    const rawElements = await collectElements(frameState.frame, frame_path);
    const elements = augmentElements(rawElements, frameState);
    const frameTree = await buildFrameTree(page);
    const media = await getMediaSummary(frameState.frame);

    const links = elements.filter((element) => element.kind === 'link');
    const buttons = elements.filter((element) => ['button', 'tab'].includes(element.kind));
    const overlays = elements.filter((element) => element.kind === 'overlay');
    const videos = elements.filter((element) => element.kind === 'video');
    const iframes = frameTree.filter((frame) =>
      frame.frame_path !== frame_path
      && (
        frame_path === 'root'
        || frame.frame_path.startsWith(`${frame_path}.`)
      ));

    return buildEnvelope(page, {
      frame_path,
      data: {
        frame_tree: frameTree,
        page_summary: {
          counts_by_kind: summarizeKinds(elements),
          links: links.length,
          buttons: buttons.length,
          overlays: overlays.length,
          videos: videos.length,
          iframes: frameTree.length - 1,
        },
        pagination: summarizePagination(elements),
        forms: summarizeForms(elements),
        player_media_signals: {
          ...media,
          has_video: media.video_count > 0,
          has_player_library: Object.values(media.player_libraries || {}).some(Boolean),
          has_iframe_player_hint: iframes.some((frame) => frame.candidate_purpose === 'player'),
        },
        top_links: compactElements(links, 8),
        top_buttons: compactElements(buttons, 8),
        top_overlays: compactElements(overlays, 5),
        top_candidates: compactElements(
          elements.filter((element) => ['link', 'button', 'tab', 'video', 'overlay', 'iframe'].includes(element.kind)),
          12,
        ),
      },
    });
  });
}

export async function queryElements({
  frame_path = 'root',
  kind = '',
  text_contains = '',
  href_contains = '',
  attr = null,
  attr_name = '',
  attr_value_contains = '',
  visible_only = true,
  limit = 20,
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const frameState = await buildFrameState(page, frame_path);
    if (!frameState.ok) {
      return buildEnvelope(page, {
        frame_path,
        ok: false,
        error: frameState.error,
      });
    }

    const rawElements = await collectElements(frameState.frame, frame_path);
    const elements = augmentElements(rawElements, frameState);
    const normalizedAttr = attr || (attr_name ? { name: attr_name, value_contains: attr_value_contains } : null);
    const matches = filterElements(elements, {
      kind,
      text_contains,
      href_contains,
      attr: normalizedAttr,
      attr_name,
      attr_value_contains,
      visible_only,
      limit,
    });

    return buildEnvelope(page, {
      frame_path,
      data: {
        query: { kind, text_contains, href_contains, attr: normalizedAttr, visible_only, limit },
        total_matches: matches.length,
        matches: compactElements(matches, limit),
      },
    });
  });
}

export async function getElementDetail({
  frame_path = 'root',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const detail = await readElementDetail(page, { frame_path, element_ref, selector, xpath, text });
    if (!detail.ok) {
      return buildEnvelope(page, {
        frame_path: detail.frame_path || frame_path,
        ok: false,
        error: detail.error,
        data: {
          error_code: detail.code || 'element_detail_failed',
        },
      });
    }

    return buildEnvelope(page, {
      frame_path: detail.frame_path,
      screenshot: detail.screenshot,
      screenshotMode: 'element',
      data: {
        detail: detail.detail,
      },
    });
  });
}

export async function getMediaState({
  frame_path = 'root',
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const frameState = await buildFrameState(page, frame_path);
    if (!frameState.ok) {
      return buildEnvelope(page, { frame_path, ok: false, error: frameState.error });
    }

    return buildEnvelope(page, {
      frame_path,
      data: {
        media_state: await getMediaSummary(frameState.frame),
      },
    });
  });
}

export async function getFrameTree({
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) =>
    buildEnvelope(page, {
      frame_path: 'root',
      data: {
        frame_tree: await buildFrameTree(page),
      },
    }));
}

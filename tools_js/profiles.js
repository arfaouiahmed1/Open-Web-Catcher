/**
 * profiles.js - defines which tools each agent is allowed to see.
 */

const CORE_CONTEXT = [
  'get_page_context',
  'query_elements',
  'get_element_detail',
  'get_frame_tree',
];

const CORE_NAVIGATION = [
  'open_url',
  'go_back',
  'scroll_page',
  'scroll_to_element',
  'wait_for_page_state',
];

const CORE_ACTIONS = [
  'click_element',
  'click_css',
  'click_text',
  'click_xpath',
  'click_checkbox',
  'click_radio',
  'type_into',
  'select_option',
  'play_media',
  'swipe_region',
  'click_coordinates',
];

export const PROFILES = {
  classification: [
    'open_url',
    'get_page_context',
    'get_frame_tree',
    'query_elements',
    'get_element_detail',
    'scroll_page',
    'go_back',
    'wait_for_page_state',
  ],
  landing: [
    ...CORE_CONTEXT,
    ...CORE_NAVIGATION,
    ...CORE_ACTIONS,
  ],
  hosting: [
    ...CORE_CONTEXT,
    ...CORE_NAVIGATION,
    ...CORE_ACTIONS,
    'get_media_state',
    'capture_streams',
  ],
  embedded: [
    ...CORE_CONTEXT,
    ...CORE_NAVIGATION,
    ...CORE_ACTIONS,
    'get_media_state',
    'capture_streams',
  ],
};

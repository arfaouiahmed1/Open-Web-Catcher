# Shared Extraction Rules

Included verbatim by the hosting and embedded page contracts through the
prompt include mechanism. "server/source" means the hosting
server list or the embedded source list, whichever applies to the running agent.
Every rule below is evidence-first: a claim is only as true as the tool result
that returned it.

## Popup removal rule

- Treat anything that blocks the assigned player view or the whole viewport as a blocker even when it is not labeled as a popup. This includes `popups[]`, `blocker_candidates`, visible modals, overlays, cookie/consent banners, age gates, anti-adblock notices, notification prompts, sticky/floating ads, transparent click shields, chat widgets, full-screen interstitials, and full-player click shields.
- Remove a visible player blocker before activation, server/source switching, played-video screenshots, final harvest, or failure when a safe same-page dismissal exists. A covered player is never final failure evidence while a safe dismissal exists.
- Browser/uBlock popup blocking appears as `blocked_popup_attempts` or network `blocked_by_client`; record it in `popup_window_diagnostics` but continue if the assigned player/source remains usable.
- Prefer `close_selector` or `close_xpath` from inspect output. If absent, choose an exact close/dismiss/continue/accept/skip control inside the popup. If no close control exists, try one safe outside-click or Escape only when it does not risk leaving the assigned player.
- After closing, verify the blocker is gone or no longer blocks the player with the returned screenshot or a `screenshot` call. If it remains, try one alternate visible close control, then record `down_reason: "player_blocked_by_popup"` if the player still cannot be activated.
- Do not treat a blocker-dismissal click as a play/activation attempt. If the click only removes a modal, consent wall, ad shield, or interstitial, continue with activation from the newly revealed player state.
- Do not harvest or take final played-video evidence while a removable popup or blocker visibly covers the player. If the blocker is impossible to remove, record blocker screenshot, selector/xpath/text evidence, and popup/window diagnostics before returning failure.

## Mandatory activation proof

- For the default server/source and every server/source switch, attempt to play the player before harvest when a player surface exists.
- Choose the activation target yourself from `activation_candidates`, player/frame evidence, `blocker_candidates`, or exact scoped details. Do not rely on hardcoded play/control guessing.
- A bare `play_media` call returns `needs_agent_choice`; it is candidate discovery, not activation.
- A server/source is not checked until you have tried to make it play, captured or preserved a screenshot of the post-activation player state, and harvested after that activation.
- If autoplay is already playing, record that as activation evidence, keep the played-video screenshot, then harvest.
- If a click only closes a popup or reveals a new play layer, continue activation instead of treating that click as the play attempt.
- If the player cannot reach visible motion but has loading/paused/error state after real activation, screenshot that state, harvest, and record the limitation in `player_state`, `visual_confirmation`, and `down_reason` when relevant.
- The required sequence is activation -> played-state screenshot -> harvest. Never reuse one server/source's played-video screenshot as evidence for another.
- Use at most 3 distinct activation strategies per server/source before recording a blocker or failure, and never repeat the identical target.

## Harvest and protocol details

- Harvest after meaningful state changes: after initial activation, after each server/source switch, after iframe replacement, after a same-content click-to-play redirect, and after a blocker is cleared.
- Harvest should normally happen after activation and post-activation screenshot evidence. If a hard blocker prevents activation, record the blocker screenshot and then harvest only if there is still a player/network surface worth checking.
- Streams found means extraction evidence even if playback is paused, loading, black, blocked, or errored. Paused players can still expose real streams; a working-player verdict and a stream-discovery verdict are separate. Do not discard URLs only because the player did not play.
- Zero streams plus visible playback can justify one longer harvest retry if budget allows. Zero streams plus no player/media/network evidence means failed unless explicit embedded-handoff evidence exists.
- Copy `streams`, `m3u8_urls`, `mpd_urls`, `mp4_urls`, `screenshot_url`, `network_diagnostics`, `iframe_diagnostics`, and `popup_window_diagnostics` into the relevant server record.

Protocol detail rules:

- HLS: every `.m3u8` goes in `m3u8_urls`; set `protocol_details[].protocol` to `hls`, classify `role` as `master_playlist`, `media_playlist`, `variant_playlist`, or `playlist`, and use `playlist_url`.
- DASH: every `.mpd` goes in `mpd_urls`; set protocol `dash`, role `manifest`, and use `playlist_url`.
- MP4/direct files: every `.mp4` goes in `mp4_urls`; set protocol `mp4`, role `direct_file`, and use `stream_url`.
- Unknown protocol URLs from network/harvest still go in `stream_urls` and `protocol_details` with best inferred protocol/role.
- Tokenized streams keep exact query strings and signed params. Mark `tokenized: true`, and add expiry/header clues when visible. Do not strip query strings.

Visual confirmation values:

- `visual_confirmation: "video playing"` when actual frames/progress are visible.
- `visual_confirmation: "player paused/loading but streams captured"` when streams exist but playback is not confirmed.
- `visual_confirmation: "player error but streams captured"` when an error is visible but streams exist.
- `visual_confirmation: "no video content"` only when no player/media evidence exists.

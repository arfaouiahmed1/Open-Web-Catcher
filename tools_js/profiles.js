/**
 * profiles.js — defines which tools each agent is allowed to see.
 *
 * When an agent connects to /mcp/<profile>/sse, the MCP server creates
 * a session exposing ONLY the tools listed in that profile.
 * The agent's LLM never sees tools from other profiles.
 */

export const PROFILES = {
  /**
   * Classification agent — calls inspect once (optionally navigate to explore),
   * then outputs its classification. No harvesting, no interaction.
   */
  classification: ['inspect', 'navigate'],

  /**
   * Landing Page agent — explores catalog pages, discovers hosting URLs.
   * Needs: inspect (DOM scan), navigate (follow links), interact (click tabs/popups),
   * screenshot (visual check). No harvest — it doesn't extract streams.
   */
  landing: ['inspect', 'navigate', 'interact', 'screenshot'],

  /**
   * Hosting Page agent — extracts streams from a known player page.
   * Full tool set including harvest (6-layer CDP detection).
   */
  hosting: ['inspect', 'interact', 'harvest', 'screenshot', 'navigate'],

  /**
   * Embedded Page agent — works inside iframes and third-party players.
   * Same tool set as hosting: needs coordinates-mode interact for cross-origin iframes.
   */
  embedded: ['inspect', 'interact', 'harvest', 'screenshot', 'navigate'],
};

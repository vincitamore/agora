/**
 * Theme: one dark palette, exported as plain constants in the primary / neutral / semantic
 * triad. The values are seeded from the operator's terminal palette so the room reads in the
 * same colors as the rest of the seat; the shape is reimplemented here rather than imported
 * from any sibling surface.
 *
 * Humans render in the accent, agents in the quiet indigo, so who is speaking reads at a glance
 * before any name is read. No emoji anywhere; section titles are ALL CAPS at the call sites.
 */

export const primary = {
  main: "#26bbd9",
  bright: "#6fd6ea",
  dim: "#1a7f93",
};

export const neutral = {
  text: "#d5d8da",
  textDim: "#9aa0b4",
  textMuted: "#6c6f93",
  subtle: "#4f5368",
  border: "#4f5368",
  borderActive: "#26bbd9",
  background: "#1c1e26",
  panel: "#2e303e",
  selection: "#3a3d4e",
};

export const semantic = {
  success: "#29d398",
  warning: "#fab795",
  error: "#e95678",
  info: "#8a8fb0",
};

/** Author kinds, as the room shows them. */
export const authorColor: Record<string, string> = {
  human: primary.main,
  agent: semantic.info,
  system: neutral.textMuted,
  unknown: neutral.textDim,
};

/** Liveness of a session on this seat: a glyph and a color, never a number. */
export const presence = {
  live: { glyph: "●", color: semantic.success, label: "live" },
  dark: { glyph: "◐", color: semantic.warning, label: "dark" },
  unknown: { glyph: "○", color: neutral.textMuted, label: "unknown" },
} as const;

export const icons = {
  room: "▣",
  search: "⌕",
  peers: "⁂",
  folded: "▸",
  unfolded: "▾",
  arrow: "→",
  bullet: "·",
  cursor: "❯",
} as const;

export const theme = { primary, neutral, semantic, authorColor, presence, icons };
export default theme;

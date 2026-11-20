/**
 * Space for the phone's own bottom bar (Android navigation buttons or the
 * gesture strip). Screens draw edge to edge, so anything near the bottom
 * must add this much room or the phone's buttons cover it.
 */

const BASE_TAB_HEIGHT = 60;
const BASE_TAB_PADDING = 8;
const EXTRA_SCROLL_ROOM = 24;

function clean(inset: number | undefined): number {
  return typeof inset === "number" && inset > 0 ? inset : 0;
}

/** Tab bar height and bottom padding for a given bottom inset. */
export function tabBarMetrics(bottomInset: number | undefined) {
  const inset = clean(bottomInset);
  return {
    height: BASE_TAB_HEIGHT + inset,
    paddingBottom: Math.max(BASE_TAB_PADDING, inset),
  };
}

/** Bottom padding for the end of a scrolling screen with no tab bar. */
export function bottomPad(bottomInset: number | undefined): number {
  return clean(bottomInset) + EXTRA_SCROLL_ROOM;
}

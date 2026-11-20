import { useThemeStore } from "../store/theme";

/** Chart colours for each theme. Recharts takes plain colour values, so these mirror the tokens in index.css. */
const CHART_COLOURS = {
  dark: { grid: "#24302c", axis: "#94a39d", tooltipBg: "#131a18", tooltipBorder: "#24302c", tooltipText: "#e6eeea" },
  light: { grid: "#e2e0d8", axis: "#5a6863", tooltipBg: "#ffffff", tooltipBorder: "#e2e0d8", tooltipText: "#14201c" },
} as const;

export type ChartColours = (typeof CHART_COLOURS)["dark" | "light"];

export function chartColours(theme: "dark" | "light"): ChartColours {
  return CHART_COLOURS[theme];
}

export function useChartColours(): ChartColours {
  return chartColours(useThemeStore((s) => s.theme));
}

/** Tooltip box style that follows the theme. */
export function tooltipStyle(c: ChartColours) {
  return { backgroundColor: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, color: c.tooltipText, borderRadius: "8px", fontSize: "12px" };
}

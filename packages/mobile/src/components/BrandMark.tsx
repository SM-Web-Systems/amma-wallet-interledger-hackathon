import Svg, { Circle, Path, Rect } from "react-native-svg";

/** Amma Wallet mark: a jade wallet with the marigold star (same artwork as the web app). */
export function BrandMark({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityLabel="Amma Wallet">
      <Rect x="12" y="7" width="40" height="28" rx="7" fill="#0b5548" transform="rotate(-8 32 21)" />
      <Rect x="5" y="17" width="54" height="41" rx="11" fill="#0b7a65" />
      <Rect x="40" y="30" width="19" height="15" rx="7.5" fill="#0b5548" />
      <Circle cx="49" cy="37.5" r="2.6" fill="#f2a93b" />
      <Path transform="translate(12.5 24.5)" fill="#f2a93b" d="M12 0c.6 6.2 5.8 11.4 12 12-6.2.6-11.4 5.8-12 12-.6-6.2-5.8-11.4-12-12C6.2 11.4 11.4 6.2 12 0Z" />
    </Svg>
  );
}

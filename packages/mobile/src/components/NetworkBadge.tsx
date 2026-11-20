import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NETWORK_LOCK, networkBadgeText } from "../shared/lib/network-lock";

// Always visible on the testnet build, so nobody mistakes test money for real money.
// It sits below the status bar and notch (the safe-area inset), not under them.
export default function NetworkBadge() {
  const insets = useSafeAreaInsets();
  const text = networkBadgeText(NETWORK_LOCK);
  if (!text) return null;
  return (
    <View accessibilityRole="text" style={{ backgroundColor: "rgba(242,169,59,0.2)", paddingTop: insets.top, paddingBottom: 4, alignItems: "center" }}>
      <Text style={{ color: "#f2a93b", fontSize: 11, fontWeight: "600" }}>{text}</Text>
    </View>
  );
}

import { Tabs } from "expo-router";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tabBarMetrics } from "../../src/shared/lib/safe-area";
import { Home, Coins, Image, ArrowLeftRight, DollarSign } from "lucide-react-native";

export default function TabLayout() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const bar = tabBarMetrics(insets.bottom);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "#131a18",
          borderTopColor: "#24302c",
          borderTopWidth: 1,
          height: bar.height,
          paddingBottom: bar.paddingBottom,
          paddingTop: 4,
        },
        tabBarActiveTintColor: "#5ee0be",
        tabBarInactiveTintColor: "#94a39d",
        tabBarLabelStyle: { fontSize: 10 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("nav.dashboard", "Home"),
          tabBarIcon: ({ color, size }) => <Home size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="tokens"
        options={{
          title: t("nav.tokens", "Tokens"),
          tabBarIcon: ({ color, size }) => <Coins size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="nfts"
        options={{
          title: t("nav.nfts", "NFTs"),
          tabBarIcon: ({ color, size }) => <Image size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="swap"
        options={{
          title: t("nav.swap", "Swap"),
          tabBarIcon: ({ color, size }) => (
            <ArrowLeftRight size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="send"
        options={{
          title: t("nav.send", "Send"),
          tabBarIcon: () => null,
          href: null,
        }}
      />
      <Tabs.Screen
        name="receive"
        options={{
          title: t("nav.receive", "Receive"),
          tabBarIcon: () => null,
          href: null,
        }}
      />
    </Tabs>
  );
}

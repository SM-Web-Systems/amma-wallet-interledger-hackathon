import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useWalletStore } from "../../src/shared/store/wallet";
import { useBalances } from "../../src/shared/hooks/useBalances";
import AccountSwitcher from "../../src/components/AccountSwitcher";
import TokenIcon from "../../src/components/TokenIcon";
import { Settings, Clock, Copy, Check, ChevronRight } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { balanceView } from "../../src/shared/lib/balance-view";

export default function Dashboard() {
  const { t } = useTranslation();
  const router = useRouter();
  const publicKey = useWalletStore(
    (s) => s.accounts.find((a) => a.id === s.activeAccountId)?.publicKey ?? ""
  );
  const network = useWalletStore((s) => s.network);
  const { data: balances, isLoading, isError, refetch, isRefetching } = useBalances();
  const view = balanceView({ isLoading, isError, data: balances });
  const [copied, setCopied] = useState(false);

  const xlmBalance = balances?.find(
    (b) => b.assetCode === "XLM" && (b.assetType === "native" || !b.assetIssuer)
  );

  const copyAddress = async () => {
    await Clipboard.setStringAsync(publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#0c1110" }}>
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingTop: 52,
          paddingBottom: 10,
          backgroundColor: "#131a18",
          borderBottomWidth: 1,
          borderBottomColor: "#24302c",
        }}
      >
        <View style={{ flex: 1 }}>
          <AccountSwitcher />
        </View>
        <TouchableOpacity onPress={() => router.push("/history")} style={{ padding: 8 }}>
          <Clock size={20} color="#94a39d" />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.push("/settings")} style={{ padding: 8 }}>
          <Settings size={20} color="#94a39d" />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#5ee0be" />}
      >
        {/* Network Badge */}
        <View style={{ flexDirection: "row", justifyContent: "center", marginBottom: 12 }}>
          <View style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: "rgba(242,169,59,0.15)",
            borderRadius: 20,
            paddingHorizontal: 12,
            paddingVertical: 4,
          }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: network === "testnet" ? "#f2a93b" : "#10b981" }} />
            <Text style={{ color: network === "testnet" ? "#f2a93b" : "#10b981", fontSize: 11, fontWeight: "500", textTransform: "capitalize" }}>
              {network}
            </Text>
          </View>
        </View>

        {/* Balance Card */}
        <View
          style={{
            alignItems: "center",
            paddingVertical: 28,
            backgroundColor: "#131a18",
            borderRadius: 16,
            borderWidth: 1,
            borderColor: "#24302c",
            marginBottom: 12,
          }}
        >
          <TokenIcon code="XLM" size={48} />
          <Text style={{ color: "#fff", fontSize: 36, fontWeight: "700", marginTop: 8 }}>
            {view.state === "error" || view.state === "loading" ? "—" : xlmBalance ? parseFloat(xlmBalance.balance).toFixed(2) : "0.00"}
          </Text>
          <Text style={{ color: "#94a39d", fontSize: 14, marginTop: 2 }}>XLM</Text>
        </View>

        {/* Copy Address */}
        <TouchableOpacity
          onPress={copyAddress}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            marginBottom: 16,
            paddingVertical: 8,
          }}
        >
          <Text style={{ color: "#94a39d", fontSize: 11, fontFamily: "monospace" }}>
            {publicKey.slice(0, 8)}...{publicKey.slice(-8)}
          </Text>
          {copied ? <Check size={12} color="#10b981" /> : <Copy size={12} color="#94a39d" />}
        </TouchableOpacity>

        {/* Quick Actions */}
        <View style={{ flexDirection: "row", gap: 10, marginBottom: 20 }}>
          {[
            { label: t("nav.send", "Send"), route: "/(tabs)/send", color: "#5ee0be" },
            { label: t("nav.receive", "Receive"), route: "/(tabs)/receive", color: "#5ee0be" },
            { label: t("nav.swap", "Swap"), route: "/(tabs)/swap", color: "#10b981" },
          ].map((action) => (
            <TouchableOpacity
              key={action.route}
              onPress={() => router.push(action.route as any)}
              style={{
                flex: 1,
                backgroundColor: action.color,
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: "center",
              }}
            >
              <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>{action.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Assets */}
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <Text style={{ color: "#fff", fontSize: 16, fontWeight: "600" }}>
            {t("dashboard.assets", "Assets")}
          </Text>
          <TouchableOpacity onPress={() => router.push("/(tabs)/tokens")}>
            <Text style={{ color: "#5ee0be", fontSize: 12 }}>{t("dashboard.viewAll", "View All")}</Text>
          </TouchableOpacity>
        </View>

        {view.stale && (
          <View accessibilityRole="alert" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: "#f59e0b55", backgroundColor: "#f59e0b1a", marginBottom: 12 }}>
            <Text style={{ color: "#fff", fontSize: 12, flex: 1 }}>{t("dashboard.staleBalance", "Could not refresh. These are your last known balances and may be out of date.")}</Text>
            <TouchableOpacity onPress={() => refetch()} accessibilityRole="button"><Text style={{ color: "#5ee0be", fontSize: 13, fontWeight: "600" }}>{t("common.retry", "Retry")}</Text></TouchableOpacity>
          </View>
        )}
        {view.state === "loading" ? (
          <ActivityIndicator color="#5ee0be" style={{ marginTop: 32 }} />
        ) : view.state === "error" ? (
          <View accessibilityRole="alert" style={{ alignItems: "center", padding: 24, marginTop: 16, borderRadius: 12, borderWidth: 1, borderColor: "#ef444455", backgroundColor: "#ef44441a" }}>
            <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>{t("dashboard.loadFailed", "Could not load your balance.")}</Text>
            <Text style={{ color: "#94a39d", fontSize: 12, marginTop: 4, textAlign: "center" }}>{t("dashboard.loadFailedHint", "Your funds are safe. Check your connection and try again.")}</Text>
            <TouchableOpacity onPress={() => refetch()} accessibilityRole="button" style={{ marginTop: 16, backgroundColor: "#5ee0be", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 }}>
              <Text style={{ color: "#0b1210", fontWeight: "600" }}>{t("common.retry", "Retry")}</Text>
            </TouchableOpacity>
          </View>
        ) : view.state === "unfunded" ? (
          <View style={{ alignItems: "center", marginTop: 24 }}>
            <Text style={{ color: "#94a39d", textAlign: "center", fontSize: 14 }}>{t("dashboard.noAssets", "No assets yet")}</Text>
            <TouchableOpacity onPress={() => router.push("/(tabs)/receive" as any)} accessibilityRole="button" style={{ marginTop: 12, backgroundColor: "#5ee0be", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 }}>
              <Text style={{ color: "#0b1210", fontWeight: "600" }}>{t("nav.receive", "Receive")}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          (balances ?? []).map((b) => {
            const code = b.assetCode || "XLM";
            const issuer = b.assetIssuer || "native";
            return (
              <TouchableOpacity
                key={`${code}-${issuer}`}
                onPress={() => router.push(`/token-detail?code=${code}&issuer=${issuer}`)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingVertical: 12,
                  paddingHorizontal: 12,
                  backgroundColor: "#131a18",
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: "#24302c",
                  marginBottom: 8,
                  gap: 12,
                }}
              >
                <TokenIcon code={code} image={b.token?.tomlImage} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>{code}</Text>
                  <Text style={{ color: "#94a39d", fontSize: 11 }}>
                    {b.token?.tomlName || (issuer === "native" ? "Stellar Lumens" : `${issuer.slice(0, 8)}…`)}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>
                    {parseFloat(b.balance).toFixed(parseFloat(b.balance) > 1000 ? 0 : 2)}
                  </Text>
                </View>
                <ChevronRight size={14} color="#94a39d" />
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

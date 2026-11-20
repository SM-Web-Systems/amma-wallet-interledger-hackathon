import { useState } from "react";
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator, RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "../src/shared/store/wallet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { bottomPad } from "../src/shared/lib/safe-area";
import { txApi } from "../src/shared/lib/api";
import {
  ChevronLeft, ArrowUpRight, ArrowDownLeft, RefreshCw, ArrowLeftRight,
} from "lucide-react-native";

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function getTxIcon(type: string, publicKey: string, from?: string) {
  if (type === "path_payment_strict_receive" || type === "path_payment_strict_send")
    return <ArrowLeftRight size={16} color="#5ee0be" />;
  if (type === "payment" || type === "create_account") {
    const isSent = from === publicKey;
    return isSent
      ? <ArrowUpRight size={16} color="#ef4444" />
      : <ArrowDownLeft size={16} color="#10b981" />;
  }
  if (type === "change_trust") return <RefreshCw size={16} color="#f2a93b" />;
  return <RefreshCw size={16} color="#94a39d" />;
}

function getTxLabel(type: string, publicKey: string, from?: string) {
  if (type === "path_payment_strict_receive" || type === "path_payment_strict_send") return "Swap";
  if (type === "create_account") return from === publicKey ? "Created Account" : "Account Funded";
  if (type === "payment") return from === publicKey ? "Sent" : "Received";
  if (type === "change_trust") return "Trustline";
  return type.replace(/_/g, " ");
}

export default function HistoryPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const publicKey = useWalletStore(
    (s) => s.accounts.find((a) => a.id === s.activeAccountId)?.publicKey ?? ""
  );

  const network = useWalletStore((s) => s.network);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["history", publicKey, network],
    queryFn: async () => {
      if (network === "public") {
        // Fetch directly from Horizon for mainnet
        const url = `https://horizon.stellar.org/accounts/${publicKey}/operations?order=desc&limit=50`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const json = await res.json();
        return json._embedded?.records || [];
      }
      return txApi.history(publicKey, 50);
    },
    enabled: !!publicKey,
  });

  const operations = Array.isArray(data) ? data : (data as any)?.operations || (data as any)?.records || [];

  return (
    <View style={{ flex: 1, backgroundColor: "#0c1110" }}>
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingTop: 52,
          paddingHorizontal: 16,
          paddingBottom: 12,
          backgroundColor: "#131a18",
          borderBottomWidth: 1,
          borderBottomColor: "#24302c",
        }}
      >
        <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
          <ChevronLeft size={24} color="#94a39d" />
        </TouchableOpacity>
        <Text style={{ color: "#fff", fontSize: 18, fontWeight: "700", flex: 1 }}>
          {t("nav.history", "History")}
        </Text>
      </View>

      {isLoading ? (
        <ActivityIndicator color="#5ee0be" style={{ marginTop: 48 }} />
      ) : operations.length === 0 ? (
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <Text style={{ color: "#94a39d", fontSize: 14 }}>
            {t("history.empty", "No transactions yet")}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 6, paddingBottom: bottomPad(insets.bottom) }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#5ee0be" />}
        >
          {operations.map((op: any, i: number) => {
            const type = op.type || op.type_i;
            const from = op.from || op.source_account;
            const to = op.to || "";
            const isSent = from === publicKey;
            const amount = op.amount || op.starting_balance || "";
            const code = op.asset_code || (op.asset_type === "native" ? "XLM" : "");
            const date = op.created_at || "";

            return (
              <View
                key={op.id || i}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  backgroundColor: "#131a18",
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: "#24302c",
                  padding: 14,
                  gap: 12,
                }}
              >
                <View
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: "rgba(11,122,101,0.15)",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {getTxIcon(type, publicKey, from)}
                </View>

                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "500" }}>
                    {getTxLabel(type, publicKey, from)}
                  </Text>
                  <Text style={{ color: "#94a39d", fontSize: 10, fontFamily: "monospace" }} numberOfLines={1}>
                    {isSent ? (to ? `→ ${to.slice(0, 8)}…${to.slice(-6)}` : "") : (from ? `← ${from.slice(0, 8)}…${from.slice(-6)}` : "")}
                  </Text>
                </View>

                <View style={{ alignItems: "flex-end" }}>
                  {amount ? (
                    <Text
                      style={{
                        color: isSent ? "#ef4444" : "#10b981",
                        fontSize: 14,
                        fontWeight: "600",
                      }}
                    >
                      {isSent ? "-" : "+"}{parseFloat(amount).toFixed(2)} {code}
                    </Text>
                  ) : null}
                  {date ? (
                    <Text style={{ color: "#94a39d", fontSize: 10 }}>{formatDate(date)}</Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}
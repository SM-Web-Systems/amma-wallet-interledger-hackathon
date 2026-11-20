import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Alert, Linking } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { bottomPad } from "../src/shared/lib/safe-area";
import { fiatApi, moneygramApi } from "../src/shared/lib/api";
import { useWalletStore } from "../src/shared/store/wallet";
import { ChevronLeft, DollarSign, Banknote, ArrowDownUp } from "lucide-react-native";

export default function BuySellScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const publicKey = useWalletStore(
    (s) => s.accounts.find((a) => a.id === s.activeAccountId)?.publicKey ?? ""
  );
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [method, setMethod] = useState<"moneygram" | "quote" | "transak">("transak");
  const [currency, setCurrency] = useState("USD");
  const [amount, setAmount] = useState("");

  const { data: mgInfo } = useQuery<{ rate?: string; amount?: string; fee?: string; limits?: any; supportedAssets?: string[]; feePercent?: number; status?: string }>({
    queryKey: ["moneygram-info"],
    queryFn: () => moneygramApi.info() as any,
  });

  const quoteMutation = useMutation({
    mutationFn: () =>
      tab === "buy"
        ? fiatApi.quoteBuy({ fiatCurrency: currency, fiatAmount: Number(amount) })
        : fiatApi.quoteSell({ fiatCurrency: currency, cryptoAmount: Number(amount) }),
    onError: (e: Error) => Alert.alert("Error", e.message),
  });

  const mgDepositMutation = useMutation({
    mutationFn: () => moneygramApi.deposit({ publicKey, amount }),
    onSuccess: (data: any) => {
      if (data.interactiveUrl) {
        Linking.openURL(data.interactiveUrl);
      }
    },
    onError: (e: Error) => Alert.alert("Error", e.message),
  });

  const mgWithdrawMutation = useMutation({
    mutationFn: () => moneygramApi.withdraw({ publicKey, amount }),
    onSuccess: (data: any) => {
      if (data.interactiveUrl) {
        Linking.openURL(data.interactiveUrl);
      }
    },
    onError: (e: Error) => Alert.alert("Error", e.message),
  });

  const handleMoneyGram = () => {
    if (!publicKey) return Alert.alert("Error", t("common.noWallet", "No active wallet"));
    if (tab === "buy") mgDepositMutation.mutate();
    else mgWithdrawMutation.mutate();
  };

  const mgLoading = mgDepositMutation.isPending || mgWithdrawMutation.isPending;
  const limits = mgInfo ? (tab === "buy" ? mgInfo.limits?.onRamp : mgInfo.limits?.offRamp) : null;
  const currencies = ["USD", "EUR", "GBP", "ZAR", "NGN", "KES", "BRL"];

  return (
    <View style={{ flex: 1, backgroundColor: "#0c1110" }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: "#24302c" }}>
        <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
          <ChevronLeft size={24} color="#b4c0bb" />
        </TouchableOpacity>
        <DollarSign size={20} color="#5ee0be" style={{ marginRight: 8 }} />
        <Text style={{ flex: 1, fontSize: 18, fontWeight: "700", color: "#fff" }}>{t("nav.buysell", "Buy & Sell")}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: bottomPad(insets.bottom) }}>
        <View style={{ flexDirection: "row", backgroundColor: "#131a18", borderRadius: 8, borderWidth: 1, borderColor: "#24302c", padding: 2 }}>
          <TouchableOpacity
            onPress={() => setTab("buy")}
            style={{ flex: 1, paddingVertical: 10, borderRadius: 6, alignItems: "center", backgroundColor: tab === "buy" ? "rgba(34,197,94,0.15)" : "transparent" }}
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: tab === "buy" ? "#4ade80" : "#94a39d" }}>
              {t("buysell.buy", "Buy")}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setTab("sell")}
            style={{ flex: 1, paddingVertical: 10, borderRadius: 6, alignItems: "center", backgroundColor: tab === "sell" ? "rgba(239,68,68,0.15)" : "transparent" }}
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: tab === "sell" ? "#f87171" : "#94a39d" }}>
              {t("buysell.sell", "Sell")}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={{ backgroundColor: "#131a18", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#24302c", gap: 12 }}>
          <Text style={{ fontSize: 12, color: "#94a39d" }}>{t("buysell.amount", "Amount")}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput
              placeholder="0.00"
              placeholderTextColor="#94a39d"
              keyboardType="numeric"
              value={amount}
              onChangeText={setAmount}
              style={{ flex: 1, backgroundColor: "#0c1110", borderWidth: 1, borderColor: "#24302c", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: "#fff", fontSize: 16 }}
            />
            <View style={{ backgroundColor: "#0c1110", borderWidth: 1, borderColor: "#24302c", borderRadius: 8, justifyContent: "center", paddingHorizontal: 12 }}>
              <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>{currency}</Text>
            </View>
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {currencies.map((c) => (
              <TouchableOpacity
                key={c}
                onPress={() => setCurrency(c)}
                style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: currency === c ? "#0b7a65" : "#24302c", backgroundColor: currency === c ? "rgba(11,122,101,0.1)" : "transparent" }}
              >
                <Text style={{ fontSize: 11, color: currency === c ? "#5ee0be" : "#94a39d" }}>{c}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={{ flexDirection: "row", gap: 8 }}>
            <TouchableOpacity
              onPress={() => setMethod("moneygram")}
              style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: method === "moneygram" ? "#0b7a65" : "#24302c", backgroundColor: method === "moneygram" ? "rgba(11,122,101,0.1)" : "transparent" }}
            >
              <Banknote size={16} color={method === "moneygram" ? "#5ee0be" : "#94a39d"} />
              <Text style={{ fontSize: 12, fontWeight: "500", color: method === "moneygram" ? "#5ee0be" : "#94a39d" }}>MoneyGram</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setMethod("quote")}
              style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: method === "quote" ? "#0b7a65" : "#24302c", backgroundColor: method === "quote" ? "rgba(11,122,101,0.1)" : "transparent" }}
            >
              <ArrowDownUp size={16} color={method === "quote" ? "#5ee0be" : "#94a39d"} />
              <Text style={{ fontSize: 12, fontWeight: "500", color: method === "quote" ? "#5ee0be" : "#94a39d" }}>{t("buysell.quote", "Quote")}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            onPress={() => setMethod("transak")}
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: method === "transak" ? "#5ee0be" : "#24302c", backgroundColor: method === "transak" ? "rgba(11,122,101,0.1)" : "transparent" }}
          >
            <DollarSign size={16} color={method === "transak" ? "#5ee0be" : "#94a39d"} />
            <Text style={{ fontSize: 12, fontWeight: "500", color: method === "transak" ? "#5ee0be" : "#94a39d" }}>{t("buysell.transak", "Card / Bank (Transak)")}</Text>
          </TouchableOpacity>

          {limits && (
            <Text style={{ fontSize: 10, color: "#94a39d" }}>
              {t("buysell.limits", "Limits")}: ${limits.min} – ${limits.max} USDC · {t("buysell.fee", "Fee")}: {mgInfo?.feePercent}%
            </Text>
          )}

          {method === "moneygram" ? (
            <TouchableOpacity
              onPress={handleMoneyGram}
              disabled={!amount || mgLoading}
              style={{ backgroundColor: "#0b7a65", borderRadius: 8, paddingVertical: 14, alignItems: "center", opacity: (!amount || mgLoading) ? 0.5 : 1 }}
            >
              {mgLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>
                  {tab === "buy" ? t("buysell.depositMG", "Deposit via MoneyGram") : t("buysell.withdrawMG", "Withdraw via MoneyGram")}
                </Text>
              )}
            </TouchableOpacity>
          ) : method === "transak" ? (
            <TouchableOpacity
              onPress={async () => {
                try {
                  const res = (await fiatApi.transakUrl({
                    walletAddress: publicKey,
                    fiatCurrency: currency,
                    fiatAmount: Number(amount || "50"),
                    type: tab === "buy" ? "buy" : "sell",
                  })) as { url: string };
                  await Linking.openURL(res.url);
                } catch (e: any) {
                  Alert.alert(t("common.error", "Error"), e?.message || t("buysell.transakUnavailable", "Buying and selling is not available right now."));
                }
              }}
              disabled={!publicKey}
              style={{ backgroundColor: "#0b7a65", borderRadius: 8, paddingVertical: 14, alignItems: "center", opacity: !publicKey ? 0.5 : 1 }}
            >
              <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>
                {tab === "buy" ? t("buysell.transakBuy", "Buy with Transak") : t("buysell.transakSell", "Sell with Transak")}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={() => quoteMutation.mutate()}
              disabled={!amount || quoteMutation.isPending}
              style={{ backgroundColor: "#0b7a65", borderRadius: 8, paddingVertical: 14, alignItems: "center", opacity: (!amount || quoteMutation.isPending) ? 0.5 : 1 }}
            >
              <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>
                {quoteMutation.isPending ? "..." : t("buysell.getQuote", "Get Quote")}
              </Text>
            </TouchableOpacity>
          )}

          {quoteMutation.data && (() => {
            const q = quoteMutation.data as { rate?: string; estimatedAmount?: string; estimatedFiat?: string; fee?: string; feePercent?: number };
            const youGet = tab === "buy" ? `${q.estimatedAmount || "—"} XLM` : `${q.estimatedFiat || "—"} ${currency}`;
            return (
              <View style={{ backgroundColor: "#0c1110", borderRadius: 8, padding: 10, gap: 4 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ fontSize: 12, color: "#94a39d" }}>{t("buysell.rate", "Rate")}</Text>
                  <Text style={{ fontSize: 12, color: "#fff" }}>{q.rate || "—"}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ fontSize: 12, color: "#94a39d" }}>{t("buysell.youGet", "You get")}</Text>
                  <Text style={{ fontSize: 12, color: "#fff" }}>{youGet}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ fontSize: 12, color: "#94a39d" }}>{t("buysell.fee", "Fee")}</Text>
                  <Text style={{ fontSize: 12, color: "#fff" }}>{q.fee || "—"} ({q.feePercent || 0}%)</Text>
                </View>
              </View>
            );
          })()}
        </View>

        {mgInfo?.status === "configured" && (
          <Text style={{ fontSize: 10, textAlign: "center", color: "#94a39d" }}>
            {t("buysell.mgPowered", "Powered by MoneyGram — 174 countries supported")}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

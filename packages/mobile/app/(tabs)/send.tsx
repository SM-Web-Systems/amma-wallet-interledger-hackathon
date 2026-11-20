import { useState, useMemo } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, Alert, Modal,
} from "react-native";
import { useTranslation } from "react-i18next";
import { useWalletStore } from "../../src/shared/store/wallet";
import { useBalances, TokenBalance } from "../../src/shared/hooks/useBalances";
import { txApi } from "../../src/shared/lib/api";
import TokenIcon from "../../src/components/TokenIcon";
import PinModal from "../../src/components/PinModal";
import { ChevronDown, Search, X } from "lucide-react-native";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  buildSignSubmit, buildPaymentXdr, verifyPayment, assertSubmitted, networkPassphraseFor, horizonBaseFor,
} from "../../src/shared/lib/local-signing";

export default function SendPage() {
  const { t } = useTranslation();
  const unlock = useWalletStore((s) => s.unlock);
  const getSecretKey = useWalletStore((s) => s.getSecretKey);
  const publicKey = useWalletStore(
    (s) => s.accounts.find((a) => a.id === s.activeAccountId)?.publicKey ?? ""
  );
  const network = useWalletStore((s) => s.network);
  const { data: balances } = useBalances();

  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [sending, setSending] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<TokenBalance | null>(null);

  const xlm = balances?.find((b) => b.assetType === "native" || (!b.assetIssuer && b.assetCode === "XLM"));
  const activeAsset = selectedAsset || xlm || null;

  const filteredBalances = useMemo(() => {
    if (!balances) return [];
    if (!pickerSearch) return balances;
    const q = pickerSearch.toLowerCase();
    return balances.filter(
      (b) =>
        b.assetCode.toLowerCase().includes(q) ||
        b.token?.tomlName?.toLowerCase().includes(q)
    );
  }, [balances, pickerSearch]);

  const validate = (): string | null => {
    if (!destination.trim()) return t("send.enterDest", "Enter a destination address");
    if (destination.length !== 56 || !destination.startsWith("G"))
      return t("send.invalidAddress", "Invalid Stellar address");
    if (!amount || parseFloat(amount) <= 0) return t("send.enterAmount", "Enter a valid amount");
    if (activeAsset && parseFloat(amount) > parseFloat(activeAsset.balance))
      return t("send.insufficientBalance", "Insufficient balance");
    return null;
  };

  const handleSend = () => {
    const err = validate();
    if (err) {
      Alert.alert(t("common.error", "Error"), err);
      return;
    }
    setShowPin(true);
  };

  const executeSend = async (pin: string) => {
    // A wrong passphrase throws here, before anything is built or sent.
    await unlock(pin);

    setSending(true);
    try {
      const passphrase = networkPassphraseFor(network);

      const assetCode = activeAsset?.assetCode || "XLM";
      const assetIssuer = activeAsset?.assetIssuer || null;

      const wanted = { source: publicKey, destination: destination.trim(), amount: amount.trim(), assetCode, assetIssuer };

      // The payment is built and signed on this phone; only the signed transaction is submitted (G-03).
      await buildSignSubmit({
        unlock: async () => {
          const secret = getSecretKey();
          if (!secret) throw new Error("Could not retrieve secret key");
          return secret;
        },
        build: async () => {
          // Plain fetch, as the rest of the phone app does; the account's next sequence number is all that is needed.
          const res = await fetch(`${horizonBaseFor(network)}/accounts/${publicKey}`);
          if (!res.ok) throw new Error(res.status === 404 ? "This account is not active on the network yet." : "Could not reach the network. Try again.");
          const account = new StellarSdk.Account(publicKey, String((await res.json()).sequence));
          return buildPaymentXdr(account, { ...wanted, memo: memo.trim() || undefined, networkPassphrase: passphrase });
        },
        submit: async (signedXdr) => {
          const res = await txApi.submit(signedXdr);
          assertSubmitted(res);
          return res;
        },
        networkPassphrase: passphrase,
        verify: verifyPayment(wanted),
      });

      Alert.alert(t("send.success", "Success"), t("send.txSent", "Transaction sent!"));
      setDestination("");
      setAmount("");
      setMemo("");
    } catch (e: any) {
      Alert.alert(t("common.error", "Error"), e.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#0c1110" }}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 60 }}>
        <Text style={{ color: "#fff", fontSize: 22, fontWeight: "700", marginBottom: 24 }}>
          {t("nav.send", "Send")}
        </Text>

        {/* Asset Picker */}
        <Text style={{ color: "#94a39d", fontSize: 12, marginBottom: 6 }}>
          {t("send.asset", "Asset")}
        </Text>
        <TouchableOpacity
          onPress={() => setShowPicker(true)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: "#131a18",
            borderWidth: 1,
            borderColor: "#24302c",
            borderRadius: 12,
            padding: 14,
            marginBottom: 16,
            gap: 10,
          }}
        >
          <TokenIcon code={activeAsset?.assetCode || "XLM"} image={activeAsset?.token?.tomlImage} size={32} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>
              {activeAsset?.assetCode || "XLM"}
            </Text>
            <Text style={{ color: "#94a39d", fontSize: 11 }}>
              {t("send.balance", "Balance")}: {activeAsset ? parseFloat(activeAsset.balance).toFixed(4) : "0"}
            </Text>
          </View>
          <ChevronDown size={16} color="#94a39d" />
        </TouchableOpacity>

        {/* Destination */}
        <Text style={{ color: "#94a39d", fontSize: 12, marginBottom: 6 }}>
          {t("send.destination", "Destination")}
        </Text>
        <TextInput
          value={destination}
          onChangeText={setDestination}
          placeholder="G..."
          placeholderTextColor="#94a39d"
          autoCapitalize="characters"
          style={{
            backgroundColor: "#131a18",
            borderWidth: 1,
            borderColor: "#24302c",
            borderRadius: 12,
            color: "#fff",
            paddingHorizontal: 16,
            paddingVertical: 14,
            fontSize: 14,
            marginBottom: 16,
            fontFamily: "monospace",
          }}
        />

        {/* Amount */}
        <Text style={{ color: "#94a39d", fontSize: 12, marginBottom: 6 }}>
          {t("send.amount", "Amount")}
        </Text>
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
          <TextInput
            value={amount}
            onChangeText={setAmount}
            placeholder="0.00"
            placeholderTextColor="#94a39d"
            keyboardType="decimal-pad"
            style={{
              flex: 1,
              backgroundColor: "#131a18",
              borderWidth: 1,
              borderColor: "#24302c",
              borderRadius: 12,
              color: "#fff",
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontSize: 16,
            }}
          />
          <TouchableOpacity
            onPress={() => activeAsset && setAmount(activeAsset.balance)}
            style={{
              backgroundColor: "rgba(11,122,101,0.2)",
              borderRadius: 12,
              paddingHorizontal: 16,
              justifyContent: "center",
            }}
          >
            <Text style={{ color: "#5ee0be", fontSize: 13, fontWeight: "600" }}>MAX</Text>
          </TouchableOpacity>
        </View>

        {/* Memo */}
        <Text style={{ color: "#94a39d", fontSize: 12, marginBottom: 6 }}>
          {t("send.memo", "Memo")} ({t("common.optional", "optional")})
        </Text>
        <TextInput
          value={memo}
          onChangeText={setMemo}
          placeholder={t("send.memoPlaceholder", "Optional memo")}
          placeholderTextColor="#94a39d"
          style={{
            backgroundColor: "#131a18",
            borderWidth: 1,
            borderColor: "#24302c",
            borderRadius: 12,
            color: "#fff",
            paddingHorizontal: 16,
            paddingVertical: 14,
            fontSize: 14,
            marginBottom: 24,
          }}
        />

        {/* Send Button */}
        <TouchableOpacity
          onPress={handleSend}
          disabled={sending}
          style={{
            backgroundColor: "#0b7a65",
            borderRadius: 14,
            paddingVertical: 16,
            alignItems: "center",
            opacity: sending ? 0.5 : 1,
          }}
        >
          {sending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "600" }}>
              {t("send.send", "Send")} {activeAsset?.assetCode || "XLM"}
            </Text>
          )}
        </TouchableOpacity>
      </ScrollView>

      {/* Asset Picker Modal */}
      <Modal visible={showPicker} transparent animationType="slide">
        <TouchableOpacity
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}
          activeOpacity={1}
          onPress={() => setShowPicker(false)}
        >
          <View
            style={{
              backgroundColor: "#131a18",
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              maxHeight: "70%",
              paddingBottom: 34,
            }}
          >
            <View style={{ alignItems: "center", paddingVertical: 12 }}>
              <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: "#24302c" }} />
            </View>
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "700", paddingHorizontal: 20, marginBottom: 12 }}>
              {t("send.selectAsset", "Select Asset")}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#0c1110", borderRadius: 10, marginHorizontal: 20, paddingHorizontal: 12, marginBottom: 8 }}>
              <Search size={14} color="#94a39d" />
              <TextInput
                value={pickerSearch}
                onChangeText={setPickerSearch}
                placeholder={t("tokens.search", "Search…")}
                placeholderTextColor="#94a39d"
                style={{ flex: 1, color: "#fff", paddingVertical: 10, paddingLeft: 8, fontSize: 14 }}
              />
            </View>
            <ScrollView>
              {filteredBalances.map((b) => (
                <TouchableOpacity
                  key={`${b.assetCode}-${b.assetIssuer || "native"}`}
                  onPress={() => { setSelectedAsset(b); setShowPicker(false); setPickerSearch(""); }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: 20,
                    paddingVertical: 12,
                    gap: 10,
                    backgroundColor: b === activeAsset ? "rgba(11,122,101,0.1)" : "transparent",
                  }}
                >
                  <TokenIcon code={b.assetCode} image={b.token?.tomlImage} size={32} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: "#fff", fontSize: 14, fontWeight: "500" }}>{b.assetCode}</Text>
                    <Text style={{ color: "#94a39d", fontSize: 11 }}>
                      {b.token?.tomlName || ""}
                    </Text>
                  </View>
                  <Text style={{ color: "#94a39d", fontSize: 12 }}>
                    {parseFloat(b.balance).toFixed(4)}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      <PinModal
        visible={showPin}
        onClose={() => setShowPin(false)}
        onConfirm={executeSend}
        title={t("send.confirmSend", "Confirm Send")}
      />
    </View>
  );
}
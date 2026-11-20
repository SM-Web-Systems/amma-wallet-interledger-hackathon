import { useEffect, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, Alert } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { BrandMark } from "../src/components/BrandMark";
import { useAuthStore } from "../src/shared/store/auth";
import { useWalletStore } from "../src/shared/store/wallet";
import { passphraseProblem } from "../src/shared/lib/passphrase";
import { useUnlockStage } from "../src/shared/lib/use-unlock-stage";

/** First run (or first run after the D8 update): choose the wallet passphrase that encrypts keys on this phone. */
export default function SetupPassphraseScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const setUnlocked = useAuthStore((s) => s.setUnlocked);
  const setupVault = useWalletStore((s) => s.setupVault);
  const hasWallets = useWalletStore((s) => s.accounts.length > 0);

  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [offerBiometrics, setOfferBiometrics] = useState(false);
  const stage = useUnlockStage(busy);

  useEffect(() => { setError(""); }, [passphrase, confirm]);

  const submit = async () => {
    const problem = passphraseProblem(passphrase);
    if (problem) return setError(problem);
    if (confirm !== passphrase) return setError(t("passphrase.mismatch", "The two passphrases do not match."));
    setBusy(true);
    try {
      await setupVault(passphrase);
      setPassphrase("");
      setConfirm("");
      setUnlocked();
      // Only offer quick unlock on a phone that can do it; otherwise carry straight on.
      if (await useWalletStore.getState().biometricUnlockAvailable()) setOfferBiometrics(true);
      else router.replace("/");
    } catch (e: any) {
      setError(e?.message || t("passphrase.setupFailed", "Could not set the passphrase."));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (useBiometrics: boolean) => {
    if (useBiometrics) {
      try {
        await useWalletStore.getState().enableBiometricUnlock();
      } catch (e: any) {
        // Say so instead of moving on as if it worked; quick unlock stays off and the passphrase keeps working.
        Alert.alert(t("common.error", "Error"), e?.message ?? "");
      }
    }
    router.replace("/");
  };

  const field = {
    backgroundColor: "#131a18", borderWidth: 1, borderColor: "#24302c", borderRadius: 12,
    color: "#e6eeea", paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, width: "100%" as const,
  };

  if (offerBiometrics) {
    return (
      <View style={{ flex: 1, backgroundColor: "#0c1110", justifyContent: "center", alignItems: "center", padding: 24, gap: 16 }}>
        <BrandMark size={64} />
        <Text style={{ fontSize: 22, fontWeight: "bold", color: "#e6eeea", textAlign: "center" }}>
          {t("passphrase.biometricTitle", "Unlock with Face ID or fingerprint?")}
        </Text>
        <Text style={{ fontSize: 14, color: "#b4c0bb", textAlign: "center" }}>
          {t("passphrase.biometricBody", "You can still use your passphrase. If you change your phone's fingerprints or face, quick unlock switches off and the passphrase keeps working.")}
        </Text>
        {error ? <Text style={{ color: "#f87171" }}>{error}</Text> : null}
        <TouchableOpacity onPress={() => finish(true)} style={{ backgroundColor: "#0b7a65", borderRadius: 12, paddingVertical: 14, width: "100%", alignItems: "center" }}>
          <Text style={{ color: "#fff", fontSize: 16, fontWeight: "600" }}>{t("passphrase.biometricYes", "Turn on quick unlock")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => finish(false)}>
          <Text style={{ color: "#5ee0be", fontSize: 15 }}>{t("passphrase.biometricNo", "Not now")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView importantForAutofill="noExcludeDescendants" style={{ flex: 1, backgroundColor: "#0c1110" }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 14 }} keyboardShouldPersistTaps="handled">
        <BrandMark size={64} />
        <Text style={{ fontSize: 24, fontWeight: "bold", color: "#e6eeea", textAlign: "center" }}>
          {t("passphrase.setupTitle", "Choose a wallet passphrase")}
        </Text>
        <Text style={{ fontSize: 14, color: "#b4c0bb", textAlign: "center" }}>
          {hasWallets
            ? t("passphrase.migrateBody", "Amma Wallet now encrypts your keys on this phone with a passphrase only you know. Choose one to continue. Your wallets stay the same.")
            : t("passphrase.setupBody", "It encrypts your keys on this phone. Use at least 12 characters, for example a short sentence. If you forget it, restore your wallet with its recovery phrase.")}
        </Text>
        <TextInput
          value={passphrase}
          onChangeText={setPassphrase}
          placeholder={t("passphrase.placeholder", "Passphrase (12+ characters)")}
          placeholderTextColor="#94a39d"
          secureTextEntry
          importantForAutofill="noExcludeDescendants"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect={false}
          style={field}
        />
        <TextInput
          value={confirm}
          onChangeText={setConfirm}
          placeholder={t("passphrase.confirmPlaceholder", "Type it again")}
          placeholderTextColor="#94a39d"
          secureTextEntry
          importantForAutofill="noExcludeDescendants"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={submit}
          style={field}
        />
        {error ? <Text style={{ color: "#f87171" }}>{error}</Text> : null}
        {busy && stage !== "working" ? (
          <Text style={{ color: "#b4c0bb", fontSize: 13, textAlign: "center" }}>
            {stage === "slow"
              ? t("passphrase.settingUp", "Setting up… encrypting your wallet on this phone. This can take a while on older phones.")
              : t("passphrase.settingUpSlow", "Still working. The app has not frozen. Older phones can take up to a minute or two. Please keep the app open.")}
          </Text>
        ) : null}
        <TouchableOpacity
          onPress={submit}
          disabled={busy}
          style={{ backgroundColor: "#0b7a65", borderRadius: 12, paddingVertical: 14, width: "100%", alignItems: "center", opacity: busy ? 0.6 : 1 }}
        >
          {busy ? <ActivityIndicator color="#fff" /> : (
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "600" }}>{t("passphrase.setupButton", "Set passphrase")}</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

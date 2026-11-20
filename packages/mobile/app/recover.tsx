import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, ScrollView, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react-native";
import { keyRecoveryApi, type RecoveryStatus } from "../src/shared/lib/api";
import { useWalletStore } from "../src/shared/store/wallet";

/**
 * Recover the wallet after forgetting the passphrase (managed wallets). Same steps as the browser:
 * email a code, start the wait (48 hours on mainnet) while the owner is warned and sending is paused,
 * then finish: the recovery phrase is released once and goes straight onto this phone.
 * The phrase is never logged or stored here. If putting it on the phone fails, it is shown once.
 */
type Step = "loading" | "off" | "intro" | "code" | "waiting" | "ready" | "done" | "rescue";

export default function RecoverScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const isUnlocked = useWalletStore((s) => s.isUnlocked);
  const [step, setStep] = useState<Step>("loading");
  const [readyAt, setReadyAt] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [rescuePhrase, setRescuePhrase] = useState("");
  const [serverSynced, setServerSynced] = useState(true);

  const apply = useCallback((s: RecoveryStatus) => {
    setReadyAt(s.readyAt);
    setStep(!s.enabled ? "off" : s.state === "waiting" ? "waiting" : s.state === "ready" ? "ready" : "intro");
  }, []);
  useEffect(() => {
    let live = true;
    keyRecoveryApi.status().then((s) => live && apply(s)).catch(() => live && setStep("off"));
    return () => { live = false; };
  }, [apply]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); } catch (e: any) { setError(e?.message || t("recover.failed", "Something went wrong. Try again.")); } finally { setBusy(false); }
  };

  const sendCode = () => run(async () => { await keyRecoveryApi.sendCode(); setStep("code"); });
  const start = () => run(async () => {
    const res = await keyRecoveryApi.start(password, code.trim());
    setReadyAt(res.readyAt); setPassword(""); setCode(""); setStep("waiting");
  });
  const cancel = () => run(async () => { await keyRecoveryApi.cancel(); setStep("intro"); });
  const finish = () => run(async () => {
    if (!isUnlocked) throw new Error(t("recover.unlockFirst", "Unlock this phone with your wallet passphrase first."));
    // Check this phone's passphrase first: the recovery phrase is released only once.
    await useWalletStore.getState().unlock(passphrase);
    const { phrase } = await keyRecoveryApi.complete(password);
    setPassword("");
    try {
      await useWalletStore.getState().importFromMnemonic("Recovered wallet", phrase, "", 0);
      try { await useWalletStore.getState().uploadKeysForBackup(passphrase); } catch { setServerSynced(false); }
      setStep("done");
    } catch {
      // Released once only: do not lose it. Shown so it can be written down.
      setRescuePhrase(phrase);
      setStep("rescue");
    }
    setPassphrase("");
  });

  const when = readyAt ? new Date(readyAt).toLocaleString() : "";
  const primary = (label: string, onPress: () => void, disabled = false) => (
    <TouchableOpacity style={[s.primary, (busy || disabled) && { opacity: 0.6 }]} disabled={busy || disabled} onPress={onPress}>
      <Text style={s.primaryText}>{label}</Text>
    </TouchableOpacity>
  );
  const field = (value: string, set: (v: string) => void, placeholder: string, extra: object = {}) => (
    <TextInput
      value={value} onChangeText={set} placeholder={placeholder} placeholderTextColor="#94a39d" style={s.input}
      autoCapitalize="none" autoCorrect={false} importantForAutofill="noExcludeDescendants" autoComplete="off" {...extra}
    />
  );

  return (
    <ScrollView style={s.page} contentContainerStyle={{ padding: 24, gap: 14 }} keyboardShouldPersistTaps="handled">
      <TouchableOpacity onPress={() => router.back()} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <ArrowLeft size={18} color="#5ee0be" />
        <Text style={{ color: "#5ee0be" }}>{t("common.back", "Back")}</Text>
      </TouchableOpacity>
      <Text style={s.title}>{t("recover.title", "Recover my wallet")}</Text>

      {step === "loading" && <ActivityIndicator color="#5ee0be" />}
      {step === "off" && <Text style={s.body}>{t("recover.off", "Wallet recovery is not available for this account.")}</Text>}

      {step === "intro" && (
        <>
          <Text style={s.body}>{t("recover.intro", "Forgot your wallet passphrase? Amma can give you back your recovery phrase so you can use your wallet again.")}</Text>
          <Text style={s.muted}>{t("recover.wait", "To keep your money safe there is a wait of 48 hours. We email you when it starts, and you can cancel any time before it ends. Sending from the wallet is paused while you wait.")}</Text>
          {primary(t("recover.emailCode", "Email me a code"), sendCode)}
        </>
      )}

      {step === "code" && (
        <>
          <Text style={s.muted}>{t("recover.codeHelp", "Enter your account password and the 6 digit code we emailed you.")}</Text>
          {field(password, setPassword, t("recover.password", "Account password"), { secureTextEntry: true })}
          {field(code, setCode, t("recover.code", "6 digit code"), { keyboardType: "number-pad", maxLength: 6 })}
          {primary(t("recover.start", "Start recovery"), start, !password || code.trim().length !== 6)}
        </>
      )}

      {step === "waiting" && (
        <>
          <Text style={[s.body, { color: "#fcd34d" }]}>{t("recover.waiting", "Recovery is waiting. It can finish after {{when}}. Sending from the wallet is paused until then.", { when })}</Text>
          <Text style={s.muted}>{t("recover.notYou", "If you did not ask for this, cancel it now and change your account password.")}</Text>
          {primary(t("recover.cancel", "Cancel recovery"), cancel)}
        </>
      )}

      {step === "ready" && (
        <>
          <Text style={s.body}>{t("recover.ready", "The wait is over. Enter your wallet passphrase for this phone and your account password to finish.")}</Text>
          {!isUnlocked && <Text style={s.error}>{t("recover.unlockFirst", "Unlock this phone with your wallet passphrase first.")}</Text>}
          {field(passphrase, setPassphrase, t("recover.passphrase", "Wallet passphrase on this phone"), { secureTextEntry: true })}
          {field(password, setPassword, t("recover.password", "Account password"), { secureTextEntry: true })}
          {primary(t("recover.finish", "Finish recovery"), finish, !passphrase || !password || !isUnlocked)}
          <TouchableOpacity disabled={busy} onPress={cancel}><Text style={[s.muted, { textDecorationLine: "underline", textAlign: "center" }]}>{t("recover.cancelInstead", "Cancel recovery instead")}</Text></TouchableOpacity>
        </>
      )}

      {step === "done" && (
        <>
          <Text style={s.body}>{t("recover.done", "Your wallet is recovered on this phone.")}</Text>
          {!serverSynced && <Text style={[s.muted, { color: "#fcd34d" }]}>{t("recover.notSynced", "Amma could not refresh its own backup copy of your key yet. Sending from this phone works. To refresh it, switch the key backup off and on again in Settings.")}</Text>}
          {primary(t("recover.home", "Go to my wallet"), () => router.replace("/"))}
        </>
      )}

      {step === "rescue" && (
        <>
          <Text style={[s.body, { color: "#fcd34d" }]}>{t("recover.rescue", "This phone could not save your wallet. Your recovery phrase is shown once below. Write it down and keep it safe, then add it with Import.")}</Text>
          <Text selectable style={s.phrase}>{rescuePhrase}</Text>
        </>
      )}

      {error ? <Text accessibilityLiveRegion="polite" style={s.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#0c1110" },
  title: { fontSize: 24, fontWeight: "bold", color: "#e6eeea" },
  body: { fontSize: 15, color: "#e6eeea", lineHeight: 22 },
  muted: { fontSize: 13, color: "#94a39d", lineHeight: 19 },
  error: { color: "#f87171", fontSize: 14 },
  input: { backgroundColor: "#131a18", borderWidth: 1, borderColor: "#24302c", borderRadius: 12, color: "#e6eeea", paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
  primary: { backgroundColor: "#0b7a65", borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  phrase: { fontFamily: "monospace", color: "#e6eeea", backgroundColor: "#131a18", borderRadius: 12, padding: 14, lineHeight: 22 },
});

import { useEffect, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform, Alert } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { BrandMark } from "../src/components/BrandMark";
import { useAuthStore } from "../src/shared/store/auth";
import { useWalletStore } from "../src/shared/store/wallet";
import { useUnlockStage } from "../src/shared/lib/use-unlock-stage";
import { useLockoutCountdown } from "../src/shared/lib/use-lockout-countdown";
import { formatCountdown } from "../src/shared/lib/lockout";

/** Unlocks the app with the wallet passphrase (or Face ID / fingerprint when switched on). */
export default function LockScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const setUnlocked = useAuthStore((s) => s.setUnlocked);
  const logout = useAuthStore((s) => s.logout);
  const unlock = useWalletStore((s) => s.unlock);

  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState(0);
  const [biometrics, setBiometrics] = useState(false);

  // Checking the passphrase is slow on older phones; say what is happening.
  const stage = useUnlockStage(busy);

  // After too many wrong tries, count the wait down instead of leaving the person guessing.
  const readWait = useWalletStore.getState().unlockWaitMs;
  const { remaining, refresh: refreshWait } = useLockoutCountdown(readWait);
  const locked = remaining > 0;
  const [wasLocked, setWasLocked] = useState(false);
  useEffect(() => {
    refreshWait();
  }, []);
  useEffect(() => {
    if (locked) {
      setWasLocked(true);
      setError("");
    } else if (wasLocked) {
      setWasLocked(false);
      setError("");
    }
  }, [locked]);

  const done = () => {
    setUnlocked();
    router.replace("/");
  };

  const tryBiometrics = async () => {
    if (await useWalletStore.getState().unlockWithBiometrics()) done();
    else setBiometrics(await useWalletStore.getState().biometricUnlockEnabled());
  };

  useEffect(() => {
    useWalletStore.getState().biometricUnlockEnabled().then((on) => {
      setBiometrics(on);
      if (on) tryBiometrics();
    });
  }, []);

  const submit = async () => {
    if (!passphrase || locked) return;
    setBusy(true);
    setError("");
    try {
      await unlock(passphrase);
      setPassphrase("");
      done();
    } catch (e: any) {
      setFailures((n) => n + 1);
      setPassphrase("");
      setError(e?.message || t("passphrase.wrong", "Wrong passphrase."));
    } finally {
      setBusy(false);
      await refreshWait();
    }
  };

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  const handleForgot = () => {
    Alert.alert(
      t("passphrase.forgotTitle", "Remove wallets from this phone?"),
      t("passphrase.forgotBody", "This deletes the encrypted keys and passphrase on this phone. You can only get the wallets back with their recovery phrases or secret keys. Funds on the network are not affected. If Amma keeps a backup of your recovery phrase, you can sign in again afterwards and use Settings > Recover my wallet (there is a 48 hour wait)."),
      [
        { text: t("common.cancel", "Cancel"), style: "cancel" },
        {
          text: t("passphrase.forgotConfirm", "Remove and sign out"),
          style: "destructive",
          onPress: async () => {
            await useWalletStore.getState().forgetDeviceKeys();
            await handleLogout();
          },
        },
      ]
    );
  };

  return (
    <KeyboardAvoidingView
      importantForAutofill="noExcludeDescendants"
      style={{ flex: 1, backgroundColor: "#0c1110", justifyContent: "center", alignItems: "center", padding: 24, gap: 14 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={{ marginBottom: 8 }}><BrandMark size={64} /></View>
      <Text style={{ fontSize: 24, fontWeight: "bold", color: "#e6eeea" }}>{t("pin.unlockTitle")}</Text>
      <Text style={{ fontSize: 14, color: "#b4c0bb", textAlign: "center" }}>
        {t("passphrase.enter", "Enter your wallet passphrase")}
      </Text>
      <TextInput
        value={passphrase}
        onChangeText={setPassphrase}
        placeholder={t("passphrase.placeholderUnlock", "Wallet passphrase")}
        placeholderTextColor="#94a39d"
        secureTextEntry
        importantForAutofill="noExcludeDescendants"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={!biometrics}
        editable={!locked}
        onSubmitEditing={submit}
        style={{
          backgroundColor: "#131a18", borderWidth: 1, borderColor: "#24302c", borderRadius: 12,
          color: "#e6eeea", paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, width: "100%",
        }}
      />
      {locked ? (
        <Text accessibilityLiveRegion="polite" style={{ color: "#f87171", textAlign: "center" }}>
          {t("passphrase.lockedOut", "Too many wrong tries. Try again in {{time}}.", { time: formatCountdown(remaining) })}
        </Text>
      ) : wasLocked ? (
        <Text style={{ color: "#5ee0be", textAlign: "center" }}>{t("passphrase.tryAgainNow", "You can try again now.")}</Text>
      ) : null}
      {!locked && error ? <Text style={{ color: "#f87171", textAlign: "center" }}>{error}</Text> : null}
      {busy && stage !== "working" ? (
        <Text style={{ color: "#b4c0bb", fontSize: 13, textAlign: "center" }}>
          {stage === "slow"
            ? t("passphrase.unlocking", "Unlocking… checking your passphrase. This can take a while on older phones.")
            : t("passphrase.unlockingSlow", "Still working. The app has not frozen. Older phones can take up to a minute or two. Please keep the app open.")}
        </Text>
      ) : null}
      <TouchableOpacity
        onPress={submit}
        disabled={busy || !passphrase || locked}
        style={{ backgroundColor: "#0b7a65", borderRadius: 12, paddingVertical: 14, width: "100%", alignItems: "center", opacity: busy || !passphrase || locked ? 0.6 : 1 }}
      >
        {busy ? <ActivityIndicator color="#fff" /> : (
          <Text style={{ color: "#fff", fontSize: 16, fontWeight: "600" }}>{t("pin.unlock")}</Text>
        )}
      </TouchableOpacity>
      {biometrics && (
        <TouchableOpacity onPress={tryBiometrics}>
          <Text style={{ color: "#5ee0be", fontSize: 15 }}>{t("passphrase.useBiometrics", "Use Face ID or fingerprint")}</Text>
        </TouchableOpacity>
      )}
      {failures >= 3 && (
        <TouchableOpacity onPress={handleForgot} style={{ marginTop: 8 }}>
          <Text style={{ color: "#f87171", fontSize: 14, textAlign: "center" }}>
            {t("passphrase.forgotLink", "Forgot your passphrase? Restore with your recovery phrase")}
          </Text>
        </TouchableOpacity>
      )}
    </KeyboardAvoidingView>
  );
}

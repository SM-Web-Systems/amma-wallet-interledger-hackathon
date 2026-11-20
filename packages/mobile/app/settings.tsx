import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Switch,
  TextInput,
} from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import {
  ArrowLeft,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Lock,
  LogOut,
  ChevronRight,
  User,
  Wallet,
  Shield,
} from "lucide-react-native";
import { useWalletStore } from "../src/shared/store/wallet";
import { useAuthStore } from "../src/shared/store/auth";
import PinModal from "../src/components/PinModal";
import { ShieldCheck } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { bottomPad } from "../src/shared/lib/safe-area";
import { signingApi, keyEscrowApi } from "../src/shared/lib/api";
import { changePassphraseProblem } from "../src/shared/lib/passphrase";
import { NETWORK_LOCK, availableNetworks } from "../src/shared/lib/network-lock";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "af", label: "Afrikaans" },
  { code: "ar", label: "العربية" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "nr", label: "isiNdebele" },
  { code: "nso", label: "Sepedi" },
  { code: "pt", label: "Português" },
  { code: "sn", label: "chiShona" },
  { code: "ss", label: "siSwati" },
  { code: "st", label: "Sesotho" },
  { code: "sw", label: "Kiswahili" },
  { code: "tn", label: "Setswana" },
  { code: "ts", label: "Xitsonga" },
  { code: "ve", label: "Tshivenda" },
  { code: "xh", label: "isiXhosa" },
  { code: "zh", label: "中文" },
  { code: "zu", label: "isiZulu" },
];

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t, i18n } = useTranslation();

  // Wallet store
  const {
    accounts,
    activeAccountId,
    network,
    setNetwork,
    lock,
    logout: walletLogout,
    getSecretKey,
    unlock,
  } = useWalletStore();

  // Auth store
  const { user, logout: authLogout } = useAuthStore();

  const activeAccount = accounts.find((a) => a.id === activeAccountId);

  // UI state
  const [showPinModal, setShowPinModal] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [showLangPicker, setShowLangPicker] = useState(false);

  // Copy public key
  const copyPublicKey = async () => {
    if (!activeAccount) return;
    await Clipboard.setStringAsync(activeAccount.publicKey);
    Alert.alert(t("common.success"), t("receive.copied"));
  };

  // Reveal secret key: check the wallet passphrase, then read the secret
  const handleRevealSecret = async (pin: string) => {
    await unlock(pin); // throws on a wrong passphrase
    const key = getSecretKey(); // no arguments — reads _secretKey from state
    if (!key) {
      // The passphrase was right, but a wallet copied from another device has no key on this phone.
      throw new Error(
        t(
          "settings.keysMissingReveal",
          "Your passphrase is correct, but this wallet's keys are not on this phone. Tap Restore under the wallet to add them."
        )
      );
    }
    setRevealedKey(key);
    setShowKey(true);
  };

  // Copy secret key
  const copySecretKey = async () => {
    if (!revealedKey) return;
    await Clipboard.setStringAsync(revealedKey);
    Alert.alert(t("common.success"), t("receive.copied"));
  };

  // Lock the app
  const handleLock = () => {
    lock();
    setRevealedKey(null);
    setShowKey(false);
    router.replace("/lock-screen");
  };

  // Full logout: clear wallet + auth
  const handleLogout = () => {
    Alert.alert(t("settings.logoutTitle"), t("settings.logoutConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("settings.logout"),
        style: "destructive",
        onPress: () => {
          walletLogout();   // clears accounts, activeAccountId, locks
          authLogout();     // clears JWT, user, PIN
          setRevealedKey(null);
          setShowKey(false);
          router.replace("/login");
        },
      },
    ]);
  };

  // Change language
  const changeLanguage = (code: string) => {
    i18n.changeLanguage(code);
    setShowLangPicker(false);
  };

  return (
    <ScrollView importantForAutofill="noExcludeDescendants" style={styles.container} contentContainerStyle={{ paddingBottom: bottomPad(insets.bottom) }}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <ArrowLeft size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("settings.title")}</Text>
        <View style={{ width: 24 }} />
      </View>

      {/* Profile Section */}
      {user && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("settings.profile")}</Text>
          <View style={styles.card}>
            <View style={styles.row}>
              <User size={20} color="#5ee0be" />
              <View style={styles.rowText}>
                <Text style={styles.label}>{t("auth.email")}</Text>
                <Text style={styles.value}>{user.email}</Text>
              </View>
            </View>
            {user.firstName && (
              <View style={styles.row}>
                <User size={20} color="#5ee0be" />
                <View style={styles.rowText}>
                  <Text style={styles.label}>{t("settings.name")}</Text>
                  <Text style={styles.value}>{user.lastName}</Text>
                </View>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Active Wallet Section */}
      {activeAccount && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("settings.activeWallet")}</Text>
          <View style={styles.card}>
            <View style={styles.row}>
              <Wallet size={20} color="#5ee0be" />
              <View style={styles.rowText}>
                <Text style={styles.label}>{activeAccount.name}</Text>
                <Text style={styles.valueMono} numberOfLines={1}>
                  {activeAccount.publicKey.slice(0, 12)}...{activeAccount.publicKey.slice(-8)}
                </Text>
              </View>
              <TouchableOpacity onPress={copyPublicKey}>
                <Copy size={18} color="#b4c0bb" />
              </TouchableOpacity>
            </View>

            {/* Secret Key */}
            <View style={styles.divider} />
            <View style={styles.row}>
              <Shield size={20} color="#f2a93b" />
              <View style={styles.rowText}>
                <Text style={styles.label}>{t("settings.secretKey")}</Text>
                {showKey && revealedKey ? (
                  <Text style={styles.valueMono} numberOfLines={1}>
                    {revealedKey.slice(0, 12)}...{revealedKey.slice(-8)}
                  </Text>
                ) : (
                  <Text style={styles.valueHidden}>••••••••••••••••</Text>
                )}
              </View>
              {showKey && revealedKey ? (
                <View style={styles.rowActions}>
                  <TouchableOpacity onPress={copySecretKey} style={styles.iconBtn}>
                    <Copy size={18} color="#b4c0bb" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      setShowKey(false);
                      setRevealedKey(null);
                    }}
                    style={styles.iconBtn}
                  >
                    <EyeOff size={18} color="#b4c0bb" />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity onPress={() => setShowPinModal(true)}>
                  <Eye size={18} color="#b4c0bb" />
                </TouchableOpacity>
              )}
            </View>
            <WalletKeysNotice
              name={activeAccount.name}
              publicKey={activeAccount.publicKey}
              hasPhrase={!!activeAccount.isHD}
            />
            {/* Recovery Phrase (if HD wallet) */}
            {activeAccount?.isHD && (
              <>
                <View style={styles.divider} />
                <RecoveryPhraseReveal publicKey={activeAccount.publicKey} />
              </>
            )}
            <View style={styles.divider} />
            <BiometricUnlockToggle />
            <View style={styles.divider} />
            <ChangePassphrase />
          </View>
        </View>
      )}

      {/* Language Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("settings.language")}</Text>
        <TouchableOpacity
          style={styles.card}
          onPress={() => setShowLangPicker(!showLangPicker)}
        >
          <View style={styles.row}>
            <Globe size={20} color="#5ee0be" />
            <View style={styles.rowText}>
              <Text style={styles.value}>
                {LANGUAGES.find((l) => l.code === i18n.language)?.label || i18n.language}
              </Text>
            </View>
            <ChevronRight size={18} color="#b4c0bb" />
          </View>
        </TouchableOpacity>
        {showLangPicker && (
          <View style={styles.langGrid}>
            {LANGUAGES.map((lang) => (
              <TouchableOpacity
                key={lang.code}
                style={[
                  styles.langBtn,
                  i18n.language === lang.code && styles.langBtnActive,
                ]}
                onPress={() => changeLanguage(lang.code)}
              >
                <Text
                  style={[
                    styles.langBtnText,
                    i18n.language === lang.code && styles.langBtnTextActive,
                  ]}
                >
                  {lang.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {/* Network Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("settings.network")}</Text>
        <View style={styles.card}>
          <View style={styles.networkRow}>
            <TouchableOpacity
              style={[
                styles.networkBtn,
                network === "testnet" && styles.networkBtnActive,
              ]}
              onPress={() => setNetwork("testnet")}
            >
              <Text
                style={[
                  styles.networkBtnText,
                  network === "testnet" && styles.networkBtnTextActive,
                ]}
              >
                Testnet
              </Text>
            </TouchableOpacity>
            {availableNetworks(NETWORK_LOCK).includes("public") && (
              <TouchableOpacity
                style={[
                  styles.networkBtn,
                  network === "public" && styles.networkBtnActive,
                ]}
                onPress={() => setNetwork("public")}
              >
                <Text
                  style={[
                    styles.networkBtnText,
                    network === "public" && styles.networkBtnTextActive,
                  ]}
                >
                  Mainnet
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>

      {/* Wallet backup and recovery */}
      <WalletBackupSection />

      {/* Actions */}
      <View style={styles.section}>
        <TouchableOpacity style={styles.actionBtn} onPress={handleLock}>
          <Lock size={20} color="#5ee0be" />
          <Text style={styles.actionBtnText}>{t("settings.lockApp")}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, styles.actionBtnDanger]}
          onPress={handleLogout}
        >
          <LogOut size={20} color="#ef4444" />
          <Text style={[styles.actionBtnText, styles.actionBtnTextDanger]}>
            {t("settings.logout")}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: 40 }} />

      {/* PIN Modal for secret key reveal */}
      <PinModal
        visible={showPinModal}
        onClose={() => setShowPinModal(false)}
        onConfirm={handleRevealSecret}
        title={t("pin.enterToProceed")}
      />
    </ScrollView>
  );
}

function WalletBackupSection() {
  const { t } = useTranslation();
  const { signingMode } = useAuthStore();
  const active = useWalletStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const [busy, setBusy] = useState(false);
  const [askFor, setAskFor] = useState<null | "backup-on" | "phrase">(null);
  // Amma's sealed backup of the one recovery phrase: null until known or when the server has it switched off.
  const [phraseBackup, setPhraseBackup] = useState<"saved" | "missing" | null>(null);
  const backupOn = signingMode === "delegated";

  useEffect(() => {
    let live = true;
    keyEscrowApi.status()
      .then((st: { enabled: boolean; hasPhrase: boolean }) => live && setPhraseBackup(!st.enabled ? null : st.hasPhrase ? "saved" : "missing"))
      .catch(() => live && setPhraseBackup(null));
    return () => {
      live = false;
    };
  }, [signingMode]);

  const switchOff = async () => {
    setBusy(true);
    try {
      await signingApi.setMode("self");
      useAuthStore.setState({ signingMode: "self" });
      Alert.alert(t("common.success"), t("settings.backupOffDone", "You now keep your own keys"));
    } catch (err: any) {
      Alert.alert(t("common.error"), err.message || t("settings.signingModeError", "Failed to update signing mode"));
    } finally {
      setBusy(false);
    }
  };

  const onToggle = () => {
    Alert.alert(
      t("settings.backupTitle", "Wallet backup and recovery"),
      backupOn ? t("settings.backupOffWarning", "Amma will stop keeping a backup, and the copy it holds is removed. If you lose this browser or phone, only your recovery phrase or secret key can get the wallet back. Make sure you have saved it. Continue?") : t("settings.backupOnWarning", "Amma will keep an encrypted copy of your key so you can restore the wallet on a new device and Amma can sign for you. The copy opens only with your wallet passphrase. Continue?"),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("common.confirm", "Continue"), onPress: () => (backupOn ? switchOff() : setAskFor("backup-on")) },
      ]
    );
  };

  // Backup on needs this phone's key sealed with the passphrase first; the server refuses delegated mode without a copy.
  const confirmBackupOn = async (passphrase: string) => {
    setAskFor(null);
    setBusy(true);
    try {
      await useWalletStore.getState().uploadKeysForBackup(passphrase);
      await signingApi.setMode("delegated");
      useAuthStore.setState({ signingMode: "delegated" });
      Alert.alert(t("common.success"), t("settings.backupOnDone", "Amma now keeps an encrypted backup of your keys"));
    } catch (err: any) {
      Alert.alert(t("common.error"), err.message || t("settings.signingModeError", "Failed to update signing mode"));
    } finally {
      setBusy(false);
    }
  };

  const confirmPhraseBackup = async (passphrase: string) => {
    setAskFor(null);
    setBusy(true);
    try {
      const phrase = await useWalletStore.getState().revealMnemonic(passphrase);
      const result = await useWalletStore.getState().backupRecoveryPhrase(phrase);
      if (result === "saved") {
        setPhraseBackup("saved");
        Alert.alert(t("common.success"), t("settings.phraseBackedUp", "Amma now keeps a sealed backup of your recovery phrase"));
      } else {
        Alert.alert(t("common.error"), t("settings.phraseBackupFailed", "The recovery phrase could not be backed up. Try again in a moment."));
      }
    } catch (err: any) {
      Alert.alert(t("common.error"), err.message || t("settings.phraseBackupFailed", "The recovery phrase could not be backed up. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  };

  const router = useRouter();
  const canBackUpPhrase = Boolean(active?.isHD);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t("settings.backupTitle", "Wallet backup and recovery")}</Text>
      <View style={styles.card}>
        {busy && <ActivityIndicator size="small" color="#5ee0be" style={{ marginBottom: 12 }} />}
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: "#e8efec", fontSize: 14 }}>{t("settings.backupSwitch", "Amma keeps an encrypted backup of my keys")}</Text>
            <Text style={{ color: "#94a39d", fontSize: 12, marginTop: 6, lineHeight: 18 }}>
              {backupOn ? t("settings.backupOnDesc", "On. If you lose this device you can restore the wallet from your Amma account with your wallet passphrase.") : t("settings.backupOffDesc", "Off. You keep your own keys. If you lose this device, only your recovery phrase or secret key can restore the wallet.")}
            </Text>
          </View>
          <Switch
            value={backupOn}
            disabled={busy}
            onValueChange={onToggle}
            accessibilityLabel={t("settings.backupSwitch", "Amma keeps an encrypted backup of my keys")}
            trackColor={{ true: "#0b7a65" }}
          />
        </View>
        {backupOn && phraseBackup && (
          <View style={{ marginTop: 14 }}>
            <Text style={{ color: "#94a39d", fontSize: 12, lineHeight: 18 }}>
              {phraseBackup === "saved"
                ? t("settings.phraseBackupSaved", "Amma has a sealed backup of your recovery phrase, so every wallet made from it can be restored.")
                : canBackUpPhrase
                  ? t("settings.phraseBackupMissing", "Your recovery phrase is not backed up yet.")
                  : t("settings.phraseBackupMissingHere", "Your recovery phrase is not backed up yet. Create or import a wallet from a recovery phrase to back it up.")}
            </Text>
            {phraseBackup === "missing" && canBackUpPhrase && (
              <TouchableOpacity style={[styles.actionBtn, { marginTop: 10 }]} disabled={busy} onPress={() => setAskFor("phrase")}>
                <ShieldCheck size={18} color="#5ee0be" />
                <Text style={styles.actionBtnText}>{t("settings.backUpPhrase", "Back up my recovery phrase")}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        <TouchableOpacity style={[styles.actionBtn, { marginTop: 14 }]} disabled={busy} onPress={() => router.push("/recover")}>
          <ShieldCheck size={18} color="#5ee0be" />
          <Text style={styles.actionBtnText}>{t("settings.recoverWallet", "Recover my wallet")}</Text>
        </TouchableOpacity>
      </View>
      <PinModal
        visible={askFor !== null}
        onClose={() => setAskFor(null)}
        onConfirm={askFor === "phrase" ? confirmPhraseBackup : confirmBackupOn}
        title={t("pin.enterToProceed")}
      />
    </View>
  );
}

/** D8: optional Face ID / fingerprint unlock. The passphrase always keeps working. */
function BiometricUnlockToggle() {
  const { t } = useTranslation();
  const [on, setOn] = useState(false);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [askPassphrase, setAskPassphrase] = useState(false);

  useEffect(() => {
    const store = useWalletStore.getState();
    store.biometricUnlockEnabled().then(setOn);
    store.biometricUnlockAvailable().then(setAvailable);
  }, []);

  const enable = async () => {
    await useWalletStore.getState().enableBiometricUnlock();
    setOn(true);
  };

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (!next) {
        await useWalletStore.getState().disableBiometricUnlock();
        setOn(false);
      } else if (!useWalletStore.getState()._vaultKey) {
        // The wallet is locked: ask for the passphrase instead of failing.
        setAskPassphrase(true);
      } else {
        await enable();
      }
    } catch (e: any) {
      Alert.alert(t("common.error", "Error"), e?.message ?? "");
    } finally {
      setBusy(false);
    }
  };

  // A phone with no fingerprint or secure face unlock cannot use this, so do not offer it.
  if (!available && !on) return null;

  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: "#e6eeea", fontSize: 14 }}>{t("passphrase.quickUnlock", "Unlock with fingerprint or face")}</Text>
        <Text style={styles.label}>{t("passphrase.quickUnlockHint", "Your passphrase still works if this stops.")}</Text>
      </View>
      <Switch value={on} disabled={busy} onValueChange={toggle} trackColor={{ true: "#0b7a65" }} />
      <PinModal
        visible={askPassphrase}
        onClose={() => setAskPassphrase(false)}
        onConfirm={async (pass: string) => {
          await useWalletStore.getState().unlock(pass); // throws on a wrong passphrase
          await enable();
        }}
        title={t("pin.enterToProceed")}
      />
    </View>
  );
}

/** Changes this phone's wallet passphrase. The wallets and fingerprint unlock are not touched. */
function ChangePassphrase() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setCurrent("");
    setNext("");
    setConfirm("");
    setError("");
  };

  const submit = async () => {
    const problem = changePassphraseProblem(current, next, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await useWalletStore.getState().changePassphrase(current, next);
      close();
      Alert.alert(t("common.success", "Success"), t("passphrase.changed", "Passphrase changed. Use the new one next time you unlock."));
    } catch (e: any) {
      setError(e?.message ?? "");
    } finally {
      setBusy(false);
    }
  };

  const input = {
    backgroundColor: "#0c1110",
    borderWidth: 1,
    borderColor: "#24302c",
    borderRadius: 10,
    color: "#e6eeea",
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginTop: 8,
  } as const;
  const field = (value: string, set: (v: string) => void, placeholder: string) => (
    <TextInput
      value={value}
      onChangeText={set}
      placeholder={placeholder}
      placeholderTextColor="#94a39d"
      secureTextEntry
      importantForAutofill="noExcludeDescendants"
      autoComplete="off"
      autoCapitalize="none"
      autoCorrect={false}
      editable={!busy}
      style={input}
    />
  );

  return (
    <View>
      <TouchableOpacity style={styles.row} onPress={() => (open ? close() : setOpen(true))}>
        <Lock size={20} color="#10b981" />
        <View style={styles.rowText}>
          <Text style={{ color: "#e6eeea", fontSize: 14 }}>{t("passphrase.change", "Change wallet passphrase")}</Text>
          <Text style={styles.label}>{t("passphrase.changeHint", "Changes the passphrase on this phone only. Your other devices keep their own.")}</Text>
        </View>
        <ChevronRight size={18} color="#b4c0bb" />
      </TouchableOpacity>
      {open && (
        <View>
          {field(current, setCurrent, t("passphrase.current", "Current passphrase"))}
          {field(next, setNext, t("passphrase.new", "New passphrase"))}
          {field(confirm, setConfirm, t("passphrase.confirmNew", "Repeat new passphrase"))}
          {error ? <Text style={{ color: "#f87171", marginTop: 8 }}>{error}</Text> : null}
          {busy ? <Text style={[styles.label, { marginTop: 8 }]}>{t("passphrase.changing", "Changing… this can take a while on older phones.")}</Text> : null}
          <TouchableOpacity
            onPress={submit}
            disabled={busy}
            style={{ backgroundColor: "#0b7a65", borderRadius: 10, paddingVertical: 12, alignItems: "center", marginTop: 12, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#fff", fontWeight: "600" }}>{t("passphrase.changeSubmit", "Change passphrase")}</Text>}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

/**
 * A wallet copied here from another device is listed without its keys (keys never
 * leave the device they were made on). Offer to restore them with the recovery
 * phrase or secret key instead of showing a row that does nothing.
 */
function WalletKeysNotice({ name, publicKey, hasPhrase }: { name: string; publicKey: string; hasPhrase: boolean }) {
  const { t } = useTranslation();
  const router = useRouter();
  const unlocked = useWalletStore((s) => s.isUnlocked);
  const [missing, setMissing] = useState(false);
  const [askBackup, setAskBackup] = useState(false);
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    let live = true;
    useWalletStore
      .getState()
      .activeWalletHasKeys()
      .then((has) => live && setMissing(!has));
    return () => {
      live = false;
    };
  }, [publicKey, unlocked, hasPhrase, recheck]);

  if (!missing) return null;
  return (
    <>
      <View style={styles.divider} />
      <View style={styles.row}>
        <ShieldCheck size={20} color="#f2a93b" />
        <View style={styles.rowText}>
          <Text style={styles.label}>
            {t("settings.keysMissing", "This wallet's keys are not on this phone")}
          </Text>
          <Text style={styles.valueHidden}>
            {t("settings.keysMissingHint", "Get it back from your Amma backup, or restore it with its 12 words or secret key.")}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 10 }}>
          <TouchableOpacity onPress={() => setAskBackup(true)}>
            <Text style={{ color: "#5ee0be", fontSize: 14, fontWeight: "600" }}>
              {t("settings.restoreBackup", "From backup")}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() =>
              router.push({ pathname: "/onboarding", params: { action: "import", name } })
            }
          >
            <Text style={{ color: "#5ee0be", fontSize: 14, fontWeight: "600" }}>
              {t("settings.restore", "Restore")}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
      <PinModal
        visible={askBackup}
        onClose={() => setAskBackup(false)}
        onConfirm={async (pass: string) => {
          // The passphrase the wallet was created with, on the device that made it.
          await useWalletStore.getState().restoreFromServerBackup(pass);
          setRecheck((n) => n + 1);
          Alert.alert(t("common.success", "Success"), t("settings.restoredBackup", "The wallet's key is now on this phone."));
        }}
        title={t("settings.backupPassphraseTitle", "Passphrase this wallet was created with")}
      />
    </>
  );
}

function RecoveryPhraseReveal({ publicKey }: { publicKey: string }) {
  const { t } = useTranslation();
  const [showPinModal, setShowPinModal] = useState(false);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const revealMnemonic = useWalletStore((s) => s.revealMnemonic);

  const handleReveal = async (passphrase: string) => {
    setPhrase(await revealMnemonic(passphrase)); // throws on a wrong passphrase
    setVisible(true);
  };

  const handleCopy = async () => {
    if (phrase) {
      await Clipboard.setStringAsync(phrase);
      Alert.alert(t("common.success"), t("receive.copied"));
    }
  };

  const handleHide = () => {
    setPhrase(null);
    setVisible(false);
  };

  return (
    <>
      <View style={styles.row}>
        <ShieldCheck size={20} color="#10b981" />
        <View style={styles.rowText}>
          <Text style={styles.label}>
            {t("settings.recoveryPhrase", "Recovery Phrase")}
          </Text>
          {visible && phrase ? (
            <Text style={[styles.valueMono, { fontSize: 11, lineHeight: 18 }]}>
              {phrase}
            </Text>
          ) : (
            <Text style={styles.valueHidden}>
              ●●●●● ●●●●● ●●●●● ●●●●● ●●●●●
            </Text>
          )}
        </View>
        {visible && phrase ? (
          <View style={styles.rowActions}>
            <TouchableOpacity onPress={handleCopy} style={styles.iconBtn}>
              <Copy size={18} color="#b4c0bb" />
            </TouchableOpacity>
            <TouchableOpacity onPress={handleHide} style={styles.iconBtn}>
              <EyeOff size={18} color="#b4c0bb" />
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity onPress={() => setShowPinModal(true)}>
            <Eye size={18} color="#b4c0bb" />
          </TouchableOpacity>
        )}
      </View>

      <PinModal
        visible={showPinModal}
        onClose={() => setShowPinModal(false)}
        onConfirm={handleReveal}
        title={t("pin.enterToProceed")}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0c1110" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 16,
  },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
  section: { paddingHorizontal: 16, marginTop: 20 },
  sectionTitle: {
    color: "#b4c0bb",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 8,
    textTransform: "uppercase",
  },
  card: { backgroundColor: "#131a18", borderRadius: 12, padding: 16 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 8 },
  rowText: { flex: 1, marginLeft: 12 },
  rowActions: { flexDirection: "row", gap: 8 },
  iconBtn: { padding: 4 },
  label: { color: "#b4c0bb", fontSize: 12 },
  value: { color: "#fff", fontSize: 15 },
  valueMono: { color: "#fff", fontSize: 13, fontFamily: "monospace" },
  valueHidden: { color: "#94a39d", fontSize: 13 },
  divider: { height: 1, backgroundColor: "#24302c", marginVertical: 8 },
  langGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  langBtn: {
    backgroundColor: "#131a18",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "#24302c",
  },
  langBtnActive: { borderColor: "#0b846c", backgroundColor: "#0b463c" },
  langBtnText: { color: "#b4c0bb", fontSize: 13 },
  langBtnTextActive: { color: "#5ee0be" },
  networkRow: { flexDirection: "row", gap: 8 },
  networkBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#24302c",
    alignItems: "center",
  },
  networkBtnActive: { borderColor: "#0b846c", backgroundColor: "#0b463c" },
  networkBtnText: { color: "#b4c0bb", fontSize: 14, fontWeight: "600" },
  networkBtnTextActive: { color: "#5ee0be" },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#131a18",
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    gap: 12,
  },
  actionBtnDanger: { borderWidth: 1, borderColor: "#7f1d1d" },
  actionBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  actionBtnTextDanger: { color: "#ef4444" },
});

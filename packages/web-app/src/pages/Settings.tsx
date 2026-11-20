import LanguageSwitcher from "../components/LanguageSwitcher";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWalletStore } from "../store/wallet";
import { useAuthStore } from "../store/auth";
import { useNavigate } from "react-router-dom";
import PinModal from "../components/PinModal";
import { toast } from "sonner";
import {
  Copy,
  Check,
  LogOut,
  Eye,
  EyeOff,
  Shield,
  KeyRound,
  User,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  Key,
  ChevronDown,
} from "lucide-react";
import TwoFaSettings from "../components/TwoFaSettings";
import ChangePassphraseCard from "../components/ChangePassphraseCard";
import WalletBackupCard from "../components/WalletBackupCard";
import StellarMoveToAmmaCard from "../components/StellarMoveToAmmaCard";
import AdvancedWalletsCard from "../components/AdvancedWalletsCard";
import { networkLabel } from "../lib/network-label";
import AccountEmail from '../components/AccountEmail';

export default function SettingsPage() {
  const { t } = useTranslation();
  const accounts = useWalletStore((s) => s.accounts);
  const network = useWalletStore((s) => s.network);
  const activeAccountId = useWalletStore((s) => s.activeAccountId);
  const getSecretKey = useWalletStore((s) => s.getSecretKey);
  const getMnemonic = useWalletStore((s) => s.getMnemonic);
  const unlock = useWalletStore((s) => s.unlock);
  const walletLogout = useWalletStore((s) => s.logout);
  const navigate = useNavigate();

  const { user, logout: authLogout, changePassword, updateProfile } = useAuthStore();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const active = accounts.find((a) => a.id === activeAccountId);
  const publicKey = active?.publicKey || "";

  const [copiedPk, setCopiedPk] = useState(false);
  const [copiedSk, setCopiedSk] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [pinAction, setPinAction] = useState<"secret" | "mnemonic">("secret");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // Recovery phrase
  const [revealedMnemonic, setRevealedMnemonic] = useState<string | null>(null);
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [copiedMnemonic, setCopiedMnemonic] = useState(false);


  // Password change
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);

  // Profile edit
  const [editingProfile, setEditingProfile] = useState(false);
  const [firstName, setFirstName] = useState(user?.firstName || "");
  const [lastName, setLastName] = useState(user?.lastName || "");
  const [profileLoading, setProfileLoading] = useState(false);

  const handleCopyPublicKey = () => {
    navigator.clipboard.writeText(publicKey);
    setCopiedPk(true);
    toast.success(t("common.copied", "Copied!"));
    setTimeout(() => setCopiedPk(false), 2000);
  };

  const handleCopySecretKey = () => {
    if (!revealedKey) return;
    navigator.clipboard.writeText(revealedKey);
    setCopiedSk(true);
    toast.success(t("common.copied", "Copied!"));
    setTimeout(() => setCopiedSk(false), 2000);
  };

  const handleCopyMnemonic = () => {
    if (!revealedMnemonic) return;
    navigator.clipboard.writeText(revealedMnemonic);
    setCopiedMnemonic(true);
    toast.success(t("common.copied", "Copied!"));
    setTimeout(() => setCopiedMnemonic(false), 2000);
  };

  const handleRevealSecret = () => {
    setPinAction("secret");
    setShowPin(true);
  };

  const handleRevealMnemonic = () => {
    setPinAction("mnemonic");
    setShowPin(true);
  };

  // A revealed key or phrase must not outlive the unlock that revealed it (idle, hidden tab, sign-out elsewhere).
  const isUnlocked = useWalletStore((s) => s.isUnlocked);
  useEffect(() => {
    if (isUnlocked) return;
    setRevealedKey(null);
    setRevealedMnemonic(null);
    setShowMnemonic(false);
  }, [isUnlocked]);

  const handleHideSecret = () => {
    setRevealedKey(null);
    setCopiedSk(false);
  };

  const handleHideMnemonic = () => {
    setRevealedMnemonic(null);
    setShowMnemonic(false);
    setCopiedMnemonic(false);
  };

  const handleChangePassword = async () => {
    if (!currentPassword)
      return toast.error(t("settings.currentPasswordRequired", "Current password is required"));
    if (newPassword.length < 8) return toast.error(t("auth.rule8chars"));
    if (!/[A-Z]/.test(newPassword)) return toast.error(t("auth.ruleUppercase"));
    if (!/\d/.test(newPassword)) return toast.error(t("auth.ruleNumber"));
    if (newPassword !== confirmNewPassword) return toast.error(t("auth.ruleMatch"));

    setPasswordLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
      toast.success(t("settings.passwordChanged"));
      setShowPasswordChange(false);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
    } catch (err: any) {
      toast.error(err.message || t("settings.passwordChangeFailed"));
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleSaveProfile = async () => {
    setProfileLoading(true);
    try {
      await updateProfile({
        firstName: firstName || undefined,
        lastName: lastName || undefined,
      });
      toast.success(t("settings.profileUpdated"));
      setEditingProfile(false);
    } catch (err: any) {
      toast.error(err.message || t("settings.profileUpdateFailed"));
    } finally {
      setProfileLoading(false);
    }
  };

  const confirmLogout = async () => {
    await authLogout();
    walletLogout();
    setShowLogoutConfirm(false);
    navigate("/login");
  };

  // Check if the active wallet is an HD wallet (has mnemonic)
  const isHDWallet = active && (active as any).isHD === true;

  return (
    <div className="space-y-6 max-w-lg">
      <h1 className="text-2xl font-bold text-stellar-text">{t("settings.title", "Settings")}</h1>
      <AccountEmail />

      {/* Profile */}
      {user && (
        <div className="bg-stellar-card border border-stellar-border rounded-2xl p-6 space-y-4">
          <h2 className="text-sm font-semibold text-stellar-muted uppercase tracking-wider">
            {t("settings.profile", "Profile")}
          </h2>

          {!editingProfile ? (
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-stellar-blue to-stellar-purple flex items-center justify-center">
                  <User size={20} className="text-stellar-text" />
                </div>
                <div>
                  <p className="text-stellar-text font-medium">
                    {user.firstName
                      ? `${user.firstName} ${user.lastName || ""}`.trim()
                      : t("settings.noNameSet", "No name set")}
                  </p>
                  <p className="text-sm text-stellar-muted">{user.email}</p>
                </div>
              </div>
              <button
                onClick={() => {
                  setFirstName(user.firstName || "");
                  setLastName(user.lastName || "");
                  setEditingProfile(true);
                }}
                className="text-sm text-stellar-link hover:text-stellar-purple transition-colors"
              >
                {t("settings.editProfile", "Edit profile")}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder={t("auth.firstNamePlaceholder")}
                  className="px-3 py-2.5 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text text-sm placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue"
                />
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder={t("auth.lastNamePlaceholder")}
                  className="px-3 py-2.5 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text text-sm placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setEditingProfile(false)}
                  className="px-4 py-2 rounded-lg border border-stellar-border text-stellar-muted text-sm hover:text-stellar-text transition-colors"
                >
                  {t("common.cancel", "Cancel")}
                </button>
                <button
                  onClick={handleSaveProfile}
                  disabled={profileLoading}
                  className="px-4 py-2 rounded-lg bg-stellar-blue text-white text-sm font-medium hover:bg-stellar-purple transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {profileLoading && <Loader2 size={14} className="animate-spin" />}
                  {t("common.save", "Save")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Wallet Info */}
      {active && <div className="bg-stellar-card border border-stellar-border rounded-2xl p-6 space-y-4">
        <h2 className="text-sm font-semibold text-stellar-muted uppercase tracking-wider">
          {t("settings.account", "Wallet")}
        </h2>

        {active && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-stellar-muted">
              {t("onboarding.walletName", "Name")}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-sm text-stellar-text font-medium">{active.name}</span>
              {isHDWallet && (
                <span className="px-1.5 py-0.5 text-[10px] rounded bg-stellar-blue/20 text-jade-800 dark:text-stellar-link font-medium">
                  HD
                </span>
              )}
            </div>
          </div>
        )}



        <div>
          <label className="block text-sm text-stellar-muted mb-1">
            {t("settings.publicKey", "Public Key")}
          </label>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 rounded-lg bg-stellar-dark border border-stellar-border text-xs text-stellar-text break-all">
              {publicKey}
            </code>
            <button
              onClick={handleCopyPublicKey}
              className="p-2 rounded-lg border border-stellar-border hover:bg-stellar-hover shrink-0"
              title={t("common.copy", "Copy")}
            >
              {copiedPk ? (
                <Check size={16} className="text-stellar-success-text" />
              ) : (
                <Copy size={16} className="text-stellar-muted" />
              )}
            </button>
          </div>
        </div>
      </div>}

      {/* Advanced Settings */}
      <div className="bg-stellar-card border border-stellar-border rounded-2xl p-6 space-y-4">
        <button
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="flex items-center justify-between w-full"
        >
          <h2 className="text-sm font-semibold text-stellar-muted uppercase tracking-wider">
            {t("settings.advanced", "Advanced Settings")}
          </h2>
          <ChevronDown
            size={18}
            className={`text-stellar-muted transition-transform ${advancedOpen ? "rotate-180" : ""}`}
          />
        </button>

        {advancedOpen && (
          <div className="space-y-6 pt-2">
            {/* Network — read-only: set by how this site is built */}
            <div className="space-y-3">
              <label className="block text-sm text-stellar-muted">
                {t("settings.network", "Network")}
              </label>
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-stellar-dark border border-stellar-border">
                <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                <span className="text-sm text-stellar-text font-medium">{networkLabel(network)}</span>
                <span className="text-xs text-stellar-muted ml-auto">
                  Managed by your institution
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Language */}
      <div className="bg-stellar-card border border-stellar-border rounded-2xl p-6">
        <LanguageSwitcher />
      </div>

      <WalletBackupCard />
      <StellarMoveToAmmaCard />

      {/* Security */}
      <div className="bg-stellar-card border border-stellar-border rounded-2xl p-6 space-y-4">
        <h2 className="text-sm font-semibold text-stellar-muted uppercase tracking-wider">
          {t("settings.security", "Security")}
        </h2>

        {/* Two-Factor Authentication */}
          <TwoFaSettings />

          <div className="border-t border-stellar-border" />

          <ChangePassphraseCard />

          <div className="border-t border-stellar-border" />

          <AdvancedWalletsCard />

          <div className="border-t border-stellar-border" />

          {/* Reveal Secret Key */}
        {!revealedKey ? (
          <button
            onClick={handleRevealSecret}
            disabled={!active}
            className="flex items-center gap-2 w-full px-4 py-3 rounded-lg border border-stellar-border text-stellar-muted hover:text-stellar-text hover:bg-stellar-hover transition-colors text-sm"
          >
            <Eye size={16} />
            {t("settings.revealSecret", "Reveal Secret Key")}
          </button>
        ) : (
          <div className="space-y-3">
            <div className="p-4 bg-stellar-danger/10 border border-stellar-danger/30 rounded-lg space-y-3">
              <div className="flex items-center gap-2">
                <Shield size={14} className="text-stellar-danger-text" />
                <p className="text-xs text-stellar-danger-text font-semibold">
                  {t("settings.secretWarning", "Never share your secret key!")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs text-stellar-text break-all select-all">
                  {revealedKey}
                </code>
                <button
                  onClick={handleCopySecretKey}
                  className="p-2 rounded-lg border border-stellar-danger/30 hover:bg-stellar-danger/20 transition-colors shrink-0"
                  title={t("common.copy", "Copy")}
                >
                  {copiedSk ? (
                    <Check size={14} className="text-stellar-success-text" />
                  ) : (
                    <Copy size={14} className="text-stellar-danger-text" />
                  )}
                </button>
              </div>
            </div>
            <button
              onClick={handleHideSecret}
              className="flex items-center gap-2 w-full px-4 py-3 rounded-lg border border-stellar-border text-stellar-muted hover:text-stellar-text hover:bg-stellar-hover transition-colors text-sm"
            >
              <EyeOff size={16} />
              {t("settings.hideSecret", "Hide Secret Key")}
            </button>
          </div>
        )}

        {/* Reveal Recovery Phrase (HD wallets only) */}
        {isHDWallet && (
          <>
            {!revealedMnemonic ? (
              <button
                onClick={handleRevealMnemonic}
                className="flex items-center gap-2 w-full px-4 py-3 rounded-lg border border-stellar-border text-stellar-muted hover:text-stellar-text hover:bg-stellar-hover transition-colors text-sm"
              >
                <ShieldCheck size={16} />
                {t("settings.revealMnemonic", "Reveal Recovery Phrase")}
              </button>
            ) : (
              <div className="space-y-3">
                <div className="p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg space-y-3">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} className="text-yellow-700 dark:text-yellow-400" />
                    <p className="text-xs text-yellow-700 dark:text-yellow-400 font-semibold">
                      {t(
                        "settings.mnemonicWarning",
                        "Never share your recovery phrase! Anyone with it can access all your funds."
                      )}
                    </p>
                  </div>
                  <div className="relative">
                    <div
                      className={`grid grid-cols-3 gap-2 p-3 rounded-lg bg-stellar-dark ${
                        !showMnemonic ? "blur-sm select-none" : ""
                      }`}
                    >
                      {revealedMnemonic.split(" ").map((word, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <span className="text-[10px] text-stellar-muted w-4 text-right">
                            {i + 1}.
                          </span>
                          <span className="text-xs text-stellar-text font-mono">{word}</span>
                        </div>
                      ))}
                    </div>
                    {!showMnemonic && (
                      <button
                        onClick={() => setShowMnemonic(true)}
                        className="absolute inset-0 flex items-center justify-center gap-2 text-stellar-text text-sm font-medium bg-black/40 rounded-lg"
                      >
                        <Eye size={16} />
                        {t("onboarding.tapToReveal", "Click to reveal")}
                      </button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {showMnemonic && (
                      <button
                        onClick={() => setShowMnemonic(false)}
                        className="flex-1 py-2 rounded-lg border border-yellow-500/30 text-xs text-yellow-700 dark:text-yellow-300 hover:bg-yellow-500/10 flex items-center justify-center gap-1.5"
                      >
                        <EyeOff size={12} />
                        {t("common.hide", "Hide")}
                      </button>
                    )}
                    <button
                      onClick={handleCopyMnemonic}
                      className="flex-1 py-2 rounded-lg border border-yellow-500/30 text-xs text-yellow-700 dark:text-yellow-300 hover:bg-yellow-500/10 flex items-center justify-center gap-1.5"
                    >
                      {copiedMnemonic ? (
                        <Check size={12} className="text-green-700 dark:text-green-400" />
                      ) : (
                        <Copy size={12} />
                      )}
                      {copiedMnemonic ? t("common.copied", "Copied") : t("common.copy", "Copy")}
                    </button>
                  </div>
                </div>
                <button
                  onClick={handleHideMnemonic}
                  className="flex items-center gap-2 w-full px-4 py-3 rounded-lg border border-stellar-border text-stellar-muted hover:text-stellar-text hover:bg-stellar-hover transition-colors text-sm"
                >
                  <EyeOff size={16} />
                  {t("settings.hideMnemonic", "Hide Recovery Phrase")}
                </button>
              </div>
            )}
          </>
        )}

        {/* Change Password */}
        {!showPasswordChange ? (
          <button
            onClick={() => setShowPasswordChange(true)}
            className="flex items-center gap-2 w-full px-4 py-3 rounded-lg border border-stellar-border text-stellar-muted hover:text-stellar-text hover:bg-stellar-hover transition-colors text-sm"
          >
            <KeyRound size={16} />
            {t("settings.changePassword", "Change sign-in password")}
          </button>
        ) : (
          <div className="space-y-3 p-4 bg-stellar-dark/50 border border-stellar-border rounded-lg">
            <h3 className="text-sm font-medium text-stellar-text flex items-center gap-2">
              <KeyRound size={16} className="text-stellar-link" />
              {t("settings.changePassword", "Change sign-in password")}
            </h3>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder={t("settings.currentPassword", "Current password")}
              className="w-full px-3 py-2.5 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text text-sm placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue"
            />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t(
                "settings.newPassword",
                "New password (min 8 chars, 1 uppercase, 1 number)"
              )}
              className="w-full px-3 py-2.5 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text text-sm placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue"
            />
            <input
              type="password"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              placeholder={t("settings.confirmNewPassword", "Confirm new password")}
              className="w-full px-3 py-2.5 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text text-sm placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue"
            />
            {newPassword.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <Check
                    size={12}
                    className={
                      newPassword.length >= 8 ? "text-green-700 dark:text-green-400" : "text-stellar-muted"
                    }
                  />
                  <span
                    className={
                      newPassword.length >= 8 ? "text-green-700 dark:text-green-400" : "text-stellar-muted"
                    }
                  >
                    At least 8 characters
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <Check
                    size={12}
                    className={
                      /[A-Z]/.test(newPassword) ? "text-green-700 dark:text-green-400" : "text-stellar-muted"
                    }
                  />
                  <span
                    className={
                      /[A-Z]/.test(newPassword) ? "text-green-700 dark:text-green-400" : "text-stellar-muted"
                    }
                  >
                    One uppercase letter
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <Check
                    size={12}
                    className={
                      /\d/.test(newPassword) ? "text-green-700 dark:text-green-400" : "text-stellar-muted"
                    }
                  />
                  <span
                    className={/\d/.test(newPassword) ? "text-green-700 dark:text-green-400" : "text-stellar-muted"}
                  >
                    One number
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <Check
                    size={12}
                    className={
                      newPassword === confirmNewPassword && confirmNewPassword.length > 0
                        ? "text-green-700 dark:text-green-400"
                        : "text-stellar-muted"
                    }
                  />
                  <span
                    className={
                      newPassword === confirmNewPassword && confirmNewPassword.length > 0
                        ? "text-green-700 dark:text-green-400"
                        : "text-stellar-muted"
                    }
                  >
                    Passwords match
                  </span>
                </div>
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => {
                  setShowPasswordChange(false);
                  setCurrentPassword("");
                  setNewPassword("");
                  setConfirmNewPassword("");
                }}
                className="px-4 py-2 rounded-lg border border-stellar-border text-stellar-muted text-sm hover:text-stellar-text transition-colors"
              >
                {t("common.cancel", "Cancel")}
              </button>
              <button
                onClick={handleChangePassword}
                disabled={passwordLoading}
                className="px-4 py-2 rounded-lg bg-stellar-blue text-white text-sm font-medium hover:bg-stellar-purple transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {passwordLoading && <Loader2 size={14} className="animate-spin" />}
                {t("settings.updatePassword", "Update Password")}
              </button>
            </div>
          </div>
        )}

        {/* API Keys Link */}
        <button
          onClick={() => navigate("/api-keys")}
          className="flex items-center gap-2 w-full px-4 py-3 rounded-lg border border-stellar-border text-stellar-muted hover:text-stellar-text hover:bg-stellar-hover transition-colors text-sm"
        >
          <Key size={16} />
          {t("settings.manageApiKeys", "Manage API Keys")}
        </button>

        {/* Logout */}
        <button
          onClick={() => setShowLogoutConfirm(true)}
          className="flex items-center gap-2 w-full px-4 py-3 rounded-lg border border-stellar-danger/30 text-stellar-danger-text hover:bg-stellar-danger/10 transition-colors text-sm"
        >
          <LogOut size={16} />
          {t("settings.logout", "Sign Out")}
        </button>
      </div>

      {/* PIN Modal */}
      {showPin && (
        <PinModal
          title={
            pinAction === "mnemonic"
              ? t("settings.enterPinToRevealMnemonic", "Enter your wallet passphrase to reveal your recovery phrase")
              : t("settings.enterPinToReveal", "Enter your wallet passphrase to reveal your secret key")
          }
          onSubmit={async (pin) => {
            await unlock(pin);
            if (pinAction === "mnemonic") {
              // unlock() decrypts any phrase this device still holds (D3).
              const mnemonic = getMnemonic();
              if (mnemonic) {
                setRevealedMnemonic(mnemonic);
              } else {
                // By design (P0-3-F10) the web app does not keep recovery phrases after setup.
                toast.error(
                  t(
                    "settings.mnemonicNotStored",
                    "Amma does not keep your recovery phrase after setup, for your safety. Use the copy you wrote down. You can still reveal the secret key."
                  )
                );
              }
            } else {
              const sk = getSecretKey();
              setRevealedKey(sk);
            }
            setShowPin(false);
          }}
          onCancel={() => setShowPin(false)}
        />
      )}

      {/* Logout Confirmation Modal */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-stellar-card border border-stellar-border rounded-2xl p-6 max-w-sm w-full space-y-4">
            <div className="flex justify-center">
              <div className="w-14 h-14 rounded-full bg-stellar-danger/15 flex items-center justify-center">
                <LogOut size={28} className="text-stellar-danger-text" />
              </div>
            </div>
            <h3 className="text-stellar-text text-lg font-bold text-center">
              {t("settings.logout", "Sign Out")}
            </h3>
            <p className="text-stellar-muted text-sm text-center">
              {t(
                "settings.logoutConfirm",
                "You will be signed out. Your wallet keys remain encrypted on this device. You can sign back in anytime."
              )}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowLogoutConfirm(false)}
                className="flex-1 py-3 rounded-xl border border-stellar-border text-stellar-muted text-sm font-medium hover:text-stellar-text transition-colors"
              >
                {t("common.cancel", "Cancel")}
              </button>
              <button
                onClick={confirmLogout}
                className="flex-1 py-3 rounded-xl bg-stellar-danger hover:bg-red-600 text-white text-sm font-medium transition-colors"
              >
                {t("settings.logout", "Sign Out")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../src/shared/store/auth";
import { TurnstileView } from "../src/shared/components/TurnstileView";

export default function LoginScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const login = useAuthStore((s) => s.login);

  const [mode, setMode] = useState<"email" | "phone">("email");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // 2FA state
  const [twoFaRequired, setTwoFaRequired] = useState(false);
  const [twoFaMessage, setTwoFaMessage] = useState("");
  const [twoFaToken, setTwoFaToken] = useState("");

  // Human check (Cloudflare Turnstile). A token works once, so the widget is
  // re-mounted (new key) after every sign-in attempt.
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaKey, setCaptchaKey] = useState(0);

  const inputStyle = {
    backgroundColor: "#131a18",
    color: "#fff",
    borderRadius: 8,
    padding: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: "#24302c",
  };

  const handleLogin = async () => {
    setError("");
    if (!identifier.trim() || !password) {
      setError(mode === "email" ? t("auth.emailRequired") : t("auth.phoneRequired", "Phone number is required"));
      return;
    }
    if (!twoFaRequired && !captchaToken) {
      setError(t("auth.captchaRequired", "Please complete the human verification"));
      return;
    }
    setLoading(true);
    try {
      const loginId = mode === "phone" ? identifier.trim() : identifier.trim();
      const res = twoFaRequired
        ? await login(loginId, password, twoFaToken)
        : await login(loginId, password, undefined, captchaToken);

      if (res?.twoFaRequired) {
        setTwoFaRequired(true);
        setTwoFaMessage(res.message);
        setLoading(false);
        return;
      }

      router.replace("/");
    } catch (e: any) {
      setError(e.message || t("auth.loginFailed"));
    } finally {
      if (!twoFaRequired) {
        setCaptchaToken("");
        setCaptchaKey((k) => k + 1);
      }
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "#0c1110" }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ fontSize: 28, fontWeight: "bold", color: "#fff", textAlign: "center", marginBottom: 8 }}>
          {t("auth.welcomeBack")}
        </Text>
        <Text style={{ fontSize: 14, color: "#b4c0bb", textAlign: "center", marginBottom: 32 }}>
          {t("auth.loginSubtitle")}
        </Text>

        {error ? (
          <View style={{ backgroundColor: "#7f1d1d", borderRadius: 8, padding: 12, marginBottom: 16 }}>
            <Text style={{ color: "#fca5a5", fontSize: 14 }}>{error}</Text>
          </View>
        ) : null}

        {!twoFaRequired ? (
          <>
            {/* Email / Phone toggle */}
            <View style={{ flexDirection: "row", backgroundColor: "#131a18", borderRadius: 8, padding: 3, marginBottom: 16 }}>
              <TouchableOpacity
                onPress={() => { setMode("email"); setIdentifier(""); }}
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 6,
                  alignItems: "center",
                  backgroundColor: mode === "email" ? "#0b7a65" : "transparent",
                }}
              >
                <Text style={{ color: mode === "email" ? "#fff" : "#b4c0bb", fontSize: 14, fontWeight: "600" }}>
                  {t("auth.email", "Email")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { setMode("phone"); setIdentifier(""); }}
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 6,
                  alignItems: "center",
                  backgroundColor: mode === "phone" ? "#0b7a65" : "transparent",
                }}
              >
                <Text style={{ color: mode === "phone" ? "#fff" : "#b4c0bb", fontSize: 14, fontWeight: "600" }}>
                  {t("auth.phone", "Phone")}
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={{ color: "#b4c0bb", fontSize: 14, marginBottom: 6 }}>
              {mode === "email" ? t("auth.email") : t("auth.phone", "Phone Number")}
            </Text>
            <TextInput
              style={{ ...inputStyle, marginBottom: 16 }}
              value={identifier}
              onChangeText={setIdentifier}
              placeholder={mode === "email" ? t("auth.emailPlaceholder") : "+14155552671"}
              placeholderTextColor="#3a4a44"
              keyboardType={mode === "email" ? "email-address" : "phone-pad"}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={{ color: "#b4c0bb", fontSize: 14, marginBottom: 6 }}>{t("auth.password")}</Text>
            <TextInput
              style={{ ...inputStyle, marginBottom: 24 }}
              value={password}
              onChangeText={setPassword}
              placeholder={t("auth.passwordPlaceholder")}
              placeholderTextColor="#3a4a44"
              secureTextEntry
            />

            <TurnstileView key={captchaKey} onToken={setCaptchaToken} />
          </>
        ) : (
          <>
            <Text style={{ color: "#b4c0bb", fontSize: 14, textAlign: "center", marginBottom: 16 }}>
              {twoFaMessage}
            </Text>
            <TextInput
              style={{ ...inputStyle, marginBottom: 24, textAlign: "center", letterSpacing: 4 }}
              value={twoFaToken}
              onChangeText={setTwoFaToken}
              placeholder={t("auth.twoFaCodePlaceholder", "Enter code")}
              placeholderTextColor="#3a4a44"
              keyboardType="number-pad"
              maxLength={8}
            />
          </>
        )}

        <TouchableOpacity
          onPress={handleLogin}
          disabled={loading}
          style={{
            backgroundColor: loading ? "#0b463c" : "#0b7a65",
            borderRadius: 8,
            padding: 16,
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "600" }}>
              {twoFaRequired ? t("auth.verify", "Verify") : t("auth.login")}
            </Text>
          )}
        </TouchableOpacity>

        {!twoFaRequired && (
          <>
            <TouchableOpacity onPress={() => router.push("/forgot-password")}>
              <Text style={{ color: "#5ee0be", fontSize: 14, textAlign: "center", marginBottom: 12 }}>
                {t("auth.forgotPassword")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push("/register")}>
              <Text style={{ color: "#5ee0be", fontSize: 14, textAlign: "center" }}>
                {t("auth.noAccount")} <Text style={{ fontWeight: "600" }}>{t("auth.register")}</Text>
              </Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

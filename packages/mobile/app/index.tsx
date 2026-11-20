import { useEffect, useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { useAuthStore } from "../src/shared/store/auth";
import { useWalletStore } from "../src/shared/store/wallet";

export default function Index() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  const { isAuthenticated, isLocked, loadProfile } = useAuthStore();
  const accounts = useWalletStore((s) => s.accounts);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);

  useEffect(() => {
    const init = async () => {
      await loadProfile();
      setNeedsPassphrase(await useWalletStore.getState().needsVaultSetup());
      setReady(true);
    };
    init();
  }, []);

  useEffect(() => {
    if (!ready) return;

    if (!isAuthenticated) {
      router.replace("/login");
    } else if (needsPassphrase) {
      router.replace("/setup-pin");
    } else if (isLocked) {
      router.replace("/lock-screen");
    } else if (accounts.length === 0) {
      router.replace("/onboarding");
    } else {
      router.replace("/(tabs)");
    }
  }, [ready, isAuthenticated, needsPassphrase, isLocked, accounts.length]);

  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0c1110" }}>
      <ActivityIndicator size="large" color="#5ee0be" />
    </View>
  );
}

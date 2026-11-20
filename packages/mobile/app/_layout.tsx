import "../src/polyfills";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuthStore } from "../src/shared/store/auth";
import "../src/shared/i18n";
import NetworkBadge from "../src/components/NetworkBadge";

const queryClient = new QueryClient();
const RELOCK_AFTER_MS = 5 * 60 * 1000;

export default function RootLayout() {
  const loadProfile = useAuthStore((s) => s.loadProfile);
  const router = useRouter();
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    loadProfile();
  }, []);

  // D8: lock again after the app has been in the background for a while.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") backgroundedAt.current = Date.now();
      if (state === "active" && backgroundedAt.current !== null) {
        const away = Date.now() - backgroundedAt.current;
        backgroundedAt.current = null;
        const { isAuthenticated, isLocked, lock } = useAuthStore.getState();
        if (isAuthenticated && !isLocked && away >= RELOCK_AFTER_MS) {
          lock();
          router.replace("/lock-screen");
        }
      }
    });
    return () => sub.remove();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style="light" />
      <NetworkBadge />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="login" />
        <Stack.Screen name="register" />
        <Stack.Screen name="setup-pin" />
        <Stack.Screen name="lock-screen" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="recover" />
        <Stack.Screen name="history" />
        <Stack.Screen name="token-detail" />
        <Stack.Screen name="forgot-password" />
        <Stack.Screen name="contacts" />
        <Stack.Screen name="earn" />
        <Stack.Screen name="buy-sell" />
        <Stack.Screen name="portfolio" />
      </Stack>
    </QueryClientProvider>
  );
}

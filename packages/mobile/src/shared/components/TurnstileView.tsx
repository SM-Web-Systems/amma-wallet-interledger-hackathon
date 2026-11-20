import { useMemo } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { API_BASE } from "../lib/config";
import { TURNSTILE_SITE_KEY, parseTurnstileMessage, turnstileHtml, turnstileOrigin } from "../lib/turnstile";

interface Props {
  /** Called with a fresh token, or "" when it expires or the check fails. */
  onToken: (token: string) => void;
}

/**
 * Cloudflare's human check, shown in a small WebView. A token can be used
 * once, so give this a new `key` after each sign-in or register attempt.
 */
export function TurnstileView({ onToken }: Props) {
  const html = useMemo(() => turnstileHtml(TURNSTILE_SITE_KEY), []);
  return (
    <View style={{ height: 80, marginBottom: 16 }}>
      <WebView
        originWhitelist={["*"]}
        source={{ html, baseUrl: turnstileOrigin(API_BASE) }}
        style={{ backgroundColor: "transparent" }}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        onMessage={(event) => {
          const message = parseTurnstileMessage(event.nativeEvent.data);
          if (!message) return;
          onToken(message.type === "token" ? message.token : "");
        }}
      />
    </View>
  );
}

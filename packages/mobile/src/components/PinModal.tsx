import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, Modal, ActivityIndicator } from "react-native";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react-native";

interface PinModalProps {
  visible: boolean;
  onClose: () => void;
  onConfirm: (pin: string) => Promise<void>;
  title?: string;
}

export default function PinModal({ visible, onClose, onConfirm, title }: PinModalProps) {
  const { t } = useTranslation();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleConfirm = async () => {
    if (!pin) {
      setError(t("passphrase.enter", "Enter your wallet passphrase"));
      return;
    }
    setLoading(true);
    setError("");
    try {
      await onConfirm(pin);
      setPin("");
      onClose();
    } catch (e: any) {
      setPin("");
      setError(e.message || t("passphrase.wrong", "Wrong passphrase."));
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setPin("");
    setError("");
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View importantForAutofill="noExcludeDescendants" style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 24 }}>
        <View style={{ backgroundColor: "#131a18", borderRadius: 16, borderWidth: 1, borderColor: "#24302c", padding: 20, gap: 14 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "700" }}>
              {title || t("passphrase.confirmTitle", "Confirm with your passphrase")}
            </Text>
            <TouchableOpacity onPress={handleClose}>
              <X size={20} color="#94a39d" />
            </TouchableOpacity>
          </View>

          <TextInput
            value={pin}
            onChangeText={setPin}
            placeholder={t("passphrase.placeholderUnlock", "Wallet passphrase")}
            placeholderTextColor="#94a39d"
            secureTextEntry
            importantForAutofill="noExcludeDescendants"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            style={{
              backgroundColor: "#0c1110",
              borderWidth: 1,
              borderColor: "#24302c",
              borderRadius: 12,
              color: "#fff",
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontSize: 16,
            }}
          />

          {error ? <Text style={{ color: "#ef4444", fontSize: 13 }}>{error}</Text> : null}

          <TouchableOpacity
            onPress={handleConfirm}
            disabled={loading}
            style={{
              backgroundColor: "#0b7a65",
              borderRadius: 12,
              paddingVertical: 14,
              alignItems: "center",
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>
                {t("common.confirm", "Confirm")}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
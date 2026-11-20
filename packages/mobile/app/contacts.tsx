import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, FlatList, Alert } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { bottomPad } from "../src/shared/lib/safe-area";
import { contactsApi } from "../src/shared/lib/api";
import { UserPlus, Trash2, Copy, ChevronLeft, Edit2, X } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";

export default function ContactsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", address: "", memo: "", notes: "" });

  const { data: contacts = [], isLoading } = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.list,
  });

  const addMutation = useMutation({
    mutationFn: contactsApi.add,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      setShowAdd(false);
      setForm({ name: "", address: "", memo: "", notes: "" });
    },
    onError: (e: Error) => Alert.alert("Error", e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: contactsApi.remove,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["contacts"] }),
    onError: (e: Error) => Alert.alert("Error", e.message),
  });

  const confirmDelete = (id: number, name: string) => {
    Alert.alert(t("contacts.delete", "Delete"), `${t("contacts.deleteConfirm", "Delete")} ${name}?`, [
      { text: t("common.cancel", "Cancel"), style: "cancel" },
      { text: t("common.delete", "Delete"), style: "destructive", onPress: () => deleteMutation.mutate(id) },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#0c1110" }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: "#24302c" }}>
        <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
          <ChevronLeft size={24} color="#b4c0bb" />
        </TouchableOpacity>
        <Text style={{ flex: 1, fontSize: 18, fontWeight: "700", color: "#fff" }}>{t("nav.contacts", "Contacts")}</Text>
        <TouchableOpacity onPress={() => setShowAdd(!showAdd)}>
          {showAdd ? <X size={22} color="#5ee0be" /> : <UserPlus size={22} color="#5ee0be" />}
        </TouchableOpacity>
      </View>

      {showAdd && (
        <View style={{ margin: 16, padding: 12, backgroundColor: "#131a18", borderRadius: 12, borderWidth: 1, borderColor: "#24302c", gap: 8 }}>
          <TextInput
            placeholder={t("contacts.name", "Name")}
            placeholderTextColor="#94a39d"
            value={form.name}
            onChangeText={(v) => setForm({ ...form, name: v })}
            style={{ backgroundColor: "#0c1110", borderWidth: 1, borderColor: "#24302c", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: "#fff", fontSize: 14 }}
          />
          <TextInput
            placeholder={t("contacts.address", "Stellar Address")}
            placeholderTextColor="#94a39d"
            value={form.address}
            onChangeText={(v) => setForm({ ...form, address: v })}
            style={{ backgroundColor: "#0c1110", borderWidth: 1, borderColor: "#24302c", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: "#fff", fontSize: 12, fontFamily: "monospace" }}
          />
          <TextInput
            placeholder={t("contacts.memo", "Memo (optional)")}
            placeholderTextColor="#94a39d"
            value={form.memo}
            onChangeText={(v) => setForm({ ...form, memo: v })}
            style={{ backgroundColor: "#0c1110", borderWidth: 1, borderColor: "#24302c", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: "#fff", fontSize: 14 }}
          />
          <TouchableOpacity
            onPress={() => addMutation.mutate(form)}
            disabled={!form.name || !form.address || addMutation.isPending}
            style={{ backgroundColor: "#0b7a65", borderRadius: 8, paddingVertical: 12, alignItems: "center", opacity: (!form.name || !form.address) ? 0.5 : 1 }}
          >
            <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>
              {addMutation.isPending ? "..." : t("contacts.save", "Save Contact")}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <FlatList
        data={contacts}
        keyExtractor={(item: any) => String(item.id)}
        contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: bottomPad(insets.bottom) }}
        ListEmptyComponent={
          <Text style={{ textAlign: "center", color: "#94a39d", marginTop: 40 }}>
            {isLoading ? t("common.loading", "Loading...") : t("contacts.empty", "No contacts yet")}
          </Text>
        }
        renderItem={({ item }: { item: any }) => (
          <View style={{ backgroundColor: "#131a18", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#24302c" }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#fff" }}>{item.name}</Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <TouchableOpacity onPress={() => Clipboard.setStringAsync(item.address)}>
                  <Copy size={16} color="#94a39d" />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => confirmDelete(item.id, item.name)}>
                  <Trash2 size={16} color="#94a39d" />
                </TouchableOpacity>
              </View>
            </View>
            <Text style={{ fontSize: 11, color: "#94a39d", fontFamily: "monospace" }} numberOfLines={1}>{item.address}</Text>
            {item.memo ? <Text style={{ fontSize: 11, color: "#94a39d", marginTop: 2 }}>Memo: {item.memo}</Text> : null}
          </View>
        )}
      />
    </View>
  );
}

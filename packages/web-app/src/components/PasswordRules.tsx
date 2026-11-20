import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface PasswordRule {
  label: string;
  valid: boolean;
}

// One rule list: a tick only when the rule is met, a cross while it is not,
// and the state is also written for screen readers (not colour alone).
export default function PasswordRules({ rules }: { rules: PasswordRule[] }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-1">
      {rules.map((r) => (
        <li key={r.label} className={`flex items-center gap-2 text-xs ${r.valid ? "text-green-700 dark:text-green-400" : "text-stellar-muted"}`}>
          {r.valid ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
          {r.label}
          <span className="sr-only">{r.valid ? `, ${t("auth.ruleMet")}` : `, ${t("auth.ruleNotMet")}`}</span>
        </li>
      ))}
    </ul>
  );
}

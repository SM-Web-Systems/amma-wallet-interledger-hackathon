import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, NavLink, Link, useNavigate, useLocation } from "react-router-dom";
import EmailVerificationBanner from "./EmailVerificationBanner";
import {
  Coins,
  Send,
  QrCode,
  ArrowLeftRight,
  LogOut,
  Home,
  History as HistoryIcon,
  HelpCircle,
  Settings as SettingsIcon,
  Key,
  Menu,
  X,
  Image as ImageIcon,
  Store,
  Sparkles,
  Waves,
  Hexagon,
  MoreHorizontal,
} from "lucide-react";
import { BrandLockup } from "./BrandMark";
import PinRetiredPrompt from "./PinRetiredPrompt";
import ServerKeyCleanupPrompt from "./ServerKeyCleanupPrompt";

import { useAuthStore } from "../store/auth";
import { useWalletStore } from "../store/wallet";
import AccountSwitcher from "./AccountSwitcher";
import { xrplEnabled } from "../lib/xrpl/feature";
import { evmEnabled } from "../lib/evm/feature";
import clsx from "clsx";
import { Droplets, BookUser, DollarSign, PieChart } from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import { quickTabsFor, type QuickTabKey } from "../lib/quick-tabs";
import NotificationBell from "./NotificationBell";
import EthAlertsPoller from "./EthAlertsPoller";
import { mainnetCustodyBuild, xrplNetworkShown, xrpNavLabel } from "../lib/custody-network";

export default function Layout() {
  const { t } = useTranslation();
  const logout = useAuthStore((s) => s.logout);
  const walletLogout = useWalletStore((s) => s.logout);
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile drawer with Escape, like other dialogs in the app.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  // Tab-bar links like /xrpl#send jump to that section of the chain page.
  useEffect(() => {
    if (!location.hash) return;
    const id = decodeURIComponent(location.hash.slice(1));
    const frame = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, location.hash]);

  const QUICK_TAB_LABELS: Record<QuickTabKey, { label: string; icon: typeof Home }> = {
    home: { label: t("nav.home", "Home"), icon: Home },
    send: { label: t("nav.send"), icon: Send },
    receive: { label: t("nav.receive"), icon: QrCode },
    swap: { label: t("nav.swap"), icon: ArrowLeftRight },
    stellar: { label: "Stellar", icon: Sparkles },
  };

  const handleLogout = async () => {
    await logout();
    walletLogout();
    navigate("/login");
  };

  const NAV_SECTIONS = [
    {
      // One entry per chain, so XRP and Ethereum are first-class, not buried.
      label: t("nav.group.wallets", "Wallets"),
      items: [
        { to: "/dashboard", label: "Stellar", icon: Sparkles },
        ...(xrplEnabled && xrplNetworkShown() ? [{ to: "/xrpl", label: xrpNavLabel(), icon: Waves }] : []),
        ...(evmEnabled ? [{ to: "/ethereum-sepolia", label: mainnetCustodyBuild() ? "Ethereum" : "Ethereum Sepolia", icon: Hexagon }] : []),
      ],
    },
    {
      label: t("nav.group.stellar", "Stellar"),
      items: [
        { to: "/tokens", label: t("nav.tokens"), icon: Coins },
        { to: "/nfts", label: t("nav.nfts", "NFTs"), icon: ImageIcon },
        { to: "/send", label: t("nav.send"), icon: Send },
        ...(import.meta.env.VITE_PAYMENTS_ENABLED==='true'?[{to:'/payments',label:t('nav.payShop','Pay shop or supplier'),icon:Store}]:[]),
        { to: "/receive", label: t("nav.receive"), icon: QrCode },
        { to: "/swap", label: t("nav.swap"), icon: ArrowLeftRight },
      ],
    },
    {
      label: t("nav.group.finance", "Finance"),
      items: [
        { to: "/buy-sell", label: t("nav.buySell", "Buy & Sell"), icon: DollarSign },
        { to: "/earn", label: t("nav.earn", "Earn"), icon: Droplets },
        { to: "/portfolio", label: t("nav.portfolio", "Portfolio"), icon: PieChart },
      ],
    },
    {
      label: t("nav.group.account", "Account"),
      items: [
        { to: "/contacts", label: t("nav.contacts", "Contacts"), icon: BookUser },
        { to: "/history", label: t("nav.history"), icon: HistoryIcon },
        { to: "/settings", label: t("nav.settings"), icon: SettingsIcon },
        { to: "/api-keys", label: t("nav.apiKeys", "API Keys"), icon: Key },
        { to: "/help", label: t("nav.help", "Help & FAQ"), icon: HelpCircle },
      ],
    },
  ];

  // Flat list for mobile header title lookup
  const NAV = NAV_SECTIONS.flatMap((s) => s.items);

  const sidebarContent = (
    <>
      <div className="hidden md:block px-5 pt-5 pb-3">
        <BrandLockup />
      </div>
      <div className="p-3 border-b border-stellar-border">
        <AccountSwitcher />
      </div>

      {user && (
        <div className="px-4 py-3 border-b border-stellar-border">
          <p className="text-sm text-stellar-text font-medium truncate">
            {user.firstName ? (user.firstName + " " + (user.lastName || "")).trim() : user.email}
          </p>
          <p className="text-xs text-stellar-muted truncate">{user.email}</p>
        </div>
      )}

      <nav className="flex-1 px-3 py-2 overflow-y-auto">
        {NAV_SECTIONS.map((section, si) => (
          <div key={si} className={si > 0 ? "mt-4" : ""}>
            {section.label && (
              <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-stellar-muted">
                {section.label}
              </p>
            )}
            <div className="space-y-0.5">
              {section.items.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    clsx(
                      "flex items-center gap-3 px-3 py-2 min-h-11 rounded-lg text-sm transition-colors",
                      isActive
                        ? "bg-stellar-blue/15 text-stellar-text font-medium shadow-[inset_3px_0_0_var(--color-stellar-link)]"
                        : "text-stellar-muted hover:text-stellar-text hover:bg-stellar-text/5"
                    )
                  }
                >
                  <Icon size={17} />
                  {label}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-stellar-border space-y-2">
        <div className="flex items-center gap-2">
          <NotificationBell />
          <ThemeToggle />
        </div>
        <a
          href="https://lms.smwebsystems.com"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 w-full px-3 py-2 min-h-11 text-sm text-stellar-muted hover:text-stellar-text rounded-lg hover:bg-stellar-text/5 transition-colors"
        >
          <ArrowLeftRight size={16} />
          Return to LMS
        </a>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 w-full px-3 py-2 min-h-11 text-sm text-red-600 dark:text-red-400 hover:text-red-500 dark:hover:text-red-300 rounded-lg hover:bg-red-500/10 transition-colors"
        >
          <LogOut size={16} />
          {t("settings.logout", "Sign Out")}
        </button>
      </div>
    </>
  );

  // Get current page title for mobile header
  const currentNav = NAV.find((n) => location.pathname.startsWith(n.to));
  const pageTitle = currentNav?.label || "Amma Wallet";

  return (
    <div className="flex min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-stellar-card focus:px-4 focus:py-2 focus:text-stellar-text"
      >
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside aria-label="Main menu" className="hidden md:flex w-64 border-r border-stellar-border bg-stellar-card flex-col shrink-0">
        {sidebarContent}
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile sidebar drawer */}
      <aside
        id="mobile-nav"
        aria-label="Main menu"
        inert={!mobileOpen}
        className={clsx(
          "fixed inset-y-0 left-0 z-50 w-72 bg-stellar-card border-r border-stellar-border flex flex-col transform transition-transform duration-200 ease-in-out md:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex items-center justify-between p-3 border-b border-stellar-border">
          <BrandLockup size={24} />
          <button
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            className="inline-flex items-center justify-center p-1 pointer-coarse:min-w-11 rounded-lg text-stellar-muted hover:text-stellar-text hover:bg-stellar-text/10 transition-colors"
          >
            <X size={20} />
          </button>
        </div>
        {sidebarContent}
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-stellar-border bg-stellar-card">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-stellar-muted hover:text-stellar-text hover:bg-stellar-text/10 transition-colors"
          >
            <Menu size={22} />
          </button>
          <h1 className="text-stellar-text font-medium text-sm truncate flex-1">{pageTitle}</h1>
          <NotificationBell />
          <ThemeToggle />
        </header>

        <EthAlertsPoller />
        <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto focus:outline-none">
          <div className="max-w-5xl mx-auto p-4 pb-24 md:p-8">
            <EmailVerificationBanner />
            <PinRetiredPrompt />
            <ServerKeyCleanupPrompt />
            <Outlet />
          </div>
        </main>

        {/* Mobile tab bar: the four things people do most, one thumb away.
            On a chain page (XRP, Ethereum) Send and Receive act on that chain. */}
        <nav aria-label="Quick menu" className="md:hidden fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-stellar-border bg-stellar-card/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
          {quickTabsFor(location.pathname).map(({ key, to, isActive }) => {
            const { label, icon: Icon } = QUICK_TAB_LABELS[key];
            const active = isActive(location.pathname, location.hash);
            return (
              <Link
                key={key}
                to={to}
                aria-current={active ? "page" : undefined}
                className={clsx("flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium", active ? "text-stellar-link" : "text-stellar-muted")}
              >
                <Icon size={20} aria-hidden />
                <span className="truncate max-w-full px-1">{label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-controls="mobile-nav"
            aria-expanded={mobileOpen}
            className="flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-stellar-muted"
          >
            <MoreHorizontal size={20} aria-hidden />
            {t("nav.more", "More")}
          </button>
        </nav>
      </div>
    </div>
  );
}

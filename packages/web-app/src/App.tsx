import { useEffect, useState, lazy, Suspense } from "react";
import { startStellarAutoLock } from "./lib/stellar-autolock";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "./store/auth";
import { useWalletStore } from "./store/wallet";
import { approvalReturnPath } from "./lib/xrpl/approval-link";
import { xrplEnabled } from "./lib/xrpl/feature";
import { xrplNetworkShown } from "./lib/custody-network";
import { evmEnabled } from "./lib/evm/feature";
import { paymentReturnPath } from './lib/payment-return';
import Layout from "./components/Layout";
import AuthRoute from "./components/AuthRoute";
import NftsPage from "./pages/Nfts";
const XrpWalletPage = lazy(() => import("./pages/XrpWallet"));
const EvmWalletPage = lazy(() => import("./pages/EvmWallet"));
const PaymentsPage = lazy(() => import("./pages/Payments"));
const PaymentConsentPage = lazy(() => import("./pages/PaymentConsent"));
const LmsClaimSignPage = lazy(() => import("./pages/LmsClaimSign"));
const RecoverWalletPage = lazy(() => import("./pages/RecoverWallet"));
const RecoveryCancelPage = lazy(() => import("./pages/RecoveryCancel"));
const LoginPage    = lazy(() => import("./pages/Login"));
const SsoLoginPage = lazy(() => import("./pages/SsoLogin"));
const RegisterPage = lazy(() => import("./pages/Register"));
const VerifyEmailPage = lazy(() => import("./pages/VerifyEmail"));
const ResetPasswordPage = lazy(() => import("./pages/ResetPassword"));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPassword"));
const OnboardingPage = lazy(() => import("./pages/Onboarding"));
const DashboardPage = lazy(() => import("./pages/Dashboard"));
const TokensPage = lazy(() => import("./pages/Tokens"));
const TokenDetailPage = lazy(() => import("./pages/TokenDetail"));
const SendPage = lazy(() => import("./pages/Send"));
const ReceivePage = lazy(() => import("./pages/Receive"));
const SwapPage = lazy(() => import("./pages/Swap"));
const HistoryPage = lazy(() => import("./pages/History"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const ApiKeysPage = lazy(() => import("./pages/ApiKeys"));
const HelpPage = lazy(() => import("./pages/Help"));
const ContactsPage = lazy(() => import("./pages/Contacts"));
const PortfolioPage = lazy(() => import("./pages/Portfolio"));
const EarnPage = lazy(() => import("./pages/Earn"));
const BuySellPage = lazy(() => import("./pages/BuySell"));
// AW-008/009 — Internal admin console (sessionStorage auth, completely separate from user flow)
const AdminLoginPage = lazy(() => import("./pages/AdminLogin"));
const BusinessAccountPage = lazy(() => import("./pages/BusinessAccount"));
const AdminConsolePage = lazy(() => import("./pages/AdminConsole"));
const AdminTenantDetailPage = lazy(() => import("./pages/AdminTenantDetail"));
// NM-D3 — Admin staff list
const AdminAdminsPage = lazy(() => import("./pages/AdminAdmins"));
// OAuth consent page — shown when an RP redirects here for authorization
const OAuthConsentPage = lazy(() => import("./pages/OAuthConsent"));

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const activeAccountId = useWalletStore((s) => s.activeAccountId);
  const accounts = useWalletStore((s) => s.accounts);

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!activeAccountId || accounts.length === 0) return <Navigate to="/onboarding" replace />;
  // A new random-key wallet is unusable until its secret key is confirmed saved (onboarding shows that step).
  if (accounts.find((a) => a.id === activeAccountId)?.backupPending) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const hasToken = !!sessionStorage.getItem("aw_admin_token");
  if (!hasToken) return <Navigate to="/admin/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const location=useLocation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const userId = useAuthStore((s) => s.user?.id);
  const loadProfile = useAuthStore((s) => s.loadProfile);
  // Hold routes until the session is restored, so pages never run without the access token.
  const [sessionReady, setSessionReady] = useState(false);

  useEffect(() => {
    loadProfile().finally(() => setSessionReady(true));
  }, []);

  // The decrypted device key does not stay in memory when idle or hidden (H3).
  useEffect(() => startStellarAutoLock(), []);

  if (!sessionReady) {
    return <div className="flex items-center justify-center min-h-screen"><div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-purple-500"></div></div>;
  }

  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-purple-500"></div></div>}>
          <Routes>
      {/* SSO entry point — must be outside AuthRoute so already-authenticated users pass through */}
      <Route path="/sso/login" element={<SsoLoginPage />} />
      {/* OAuth consent — must be outside AuthRoute (handles own auth check) */}
      <Route path="/oauth/authorize" element={<OAuthConsentPage />} />

      {/* Public auth routes */}
      <Route path="/login" element={<AuthRoute><LoginPage /></AuthRoute>} />
      <Route path="/register" element={<AuthRoute><RegisterPage /></AuthRoute>} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      {/* Wallet recovery: the cancel link in the alert email works without signing in */}
      <Route path="/recovery/cancel" element={<RecoveryCancelPage />} />
      <Route path="/recover" element={isAuthenticated ? <RecoverWalletPage /> : <Navigate to="/login" state={{returnTo: '/recover'}} replace />} />
            <Route path="/reset-password" element={<AuthRoute><ResetPasswordPage /></AuthRoute>} />
      <Route path="/forgot-password" element={<AuthRoute><ForgotPasswordPage /></AuthRoute>} />

      {/* Onboarding — requires auth but no wallet yet */}
      <Route
        path="/onboarding"
        element={
          isAuthenticated ? <OnboardingPage /> : <Navigate to="/login" replace />
        }
      />
      <Route path="/" element={<Navigate to={isAuthenticated ? "/dashboard" : "/login"} replace />} />
      {/* LMS reward claim: the challenge travels in the URL fragment; sign-in keeps it via returnTo.
          Not behind VITE_PAYMENTS_ENABLED: Pay shop stays off, but the LMS claim must always be reachable. */}
      <Route path="/lms/claim" element={isAuthenticated?<LmsClaimSignPage key={userId}/>:<Navigate to="/login" state={{returnTo:`/lms/claim${location.hash}`}} replace/>}/>
      {import.meta.env.VITE_PAYMENTS_ENABLED==='true'&&<>
        <Route path="/payments" element={isAuthenticated?<PaymentsPage key={userId}/>:<Navigate to="/login" state={{paymentReturn:paymentReturnPath(`/payments${location.search}`)}} replace/>}/>
        <Route path="/payments/consent" element={isAuthenticated?<PaymentConsentPage key={userId}/>:<Navigate to="/login" state={{paymentReturn:paymentReturnPath(`/payments/consent${location.search}`)}} replace/>}/>
      </>}
      {/* Email recovery must be available before creating a Stellar wallet. */}
      <Route element={isAuthenticated ? <Layout /> : <Navigate to="/login" state={{returnTo: '/settings'}} replace />}>
        <Route path="/settings" element={<SettingsPage />} />
      </Route>

      {/* XRP needs only a signed-in user (no Stellar wallet), but shares the app menu. */}
      {xrplEnabled && xrplNetworkShown() && (
        <Route element={isAuthenticated && userId ? <Layout /> : <Navigate to="/login" state={{xrplApproval:approvalReturnPath(`/xrpl${location.search}`)}} replace />}>
          <Route path="/xrpl" element={<XrpWalletPage key={`${userId}:${location.search}`} />} />
        </Route>
      )}

      {/* Protected app routes */}
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/tokens" element={<TokensPage />} />
        <Route path="/tokens/:code/:issuer" element={<TokenDetailPage />} />
        <Route path="/send" element={<SendPage />} />
        <Route path="/receive" element={<ReceivePage />} />
        <Route path="/swap" element={<SwapPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/api-keys" element={<ApiKeysPage />} />
        <Route path="/portfolio" element={<PortfolioPage />} />
          <Route path="/earn" element={<EarnPage />} />
          <Route path="/buy-sell" element={<BuySellPage />} />
          <Route path="/help" element={<HelpPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/nfts" element={<NftsPage />} />
        {evmEnabled && <Route path="/ethereum-sepolia" element={<EvmWalletPage key={userId} />} />}
      </Route>

      {/* Internal admin console — sessionStorage JWT auth, no user auth required */}
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route path="/business" element={<BusinessAccountPage />} />
      <Route path="/admin/tenants/:id" element={<AdminRoute><AdminTenantDetailPage /></AdminRoute>} />
      <Route path="/admin/admins" element={<AdminRoute><AdminAdminsPage /></AdminRoute>} />
      <Route path="/admin" element={<AdminRoute><AdminConsolePage /></AdminRoute>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
          </Suspense>
  );
}

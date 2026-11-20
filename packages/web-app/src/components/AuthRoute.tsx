import { Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { approvalReturnPath } from "../lib/xrpl/approval-link";
import { xrplEnabled } from "../lib/xrpl/feature";
import { paymentReturnPath } from "../lib/payment-return";
import { authenticatedAuthRouteTarget } from "../lib/post-login-path";
import { peekPendingOAuth } from "../lib/pending-oauth";
import AuthNetworkChip from "./AuthNetworkChip";

/** Wraps sign-in/sign-up pages: an already signed-in user is sent on to where they were going. */
export default function AuthRoute({ children }: { children: React.ReactNode }) {
  const location=useLocation();
  const approval=xrplEnabled?approvalReturnPath(location.state?.xrplApproval):null;
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const paymentReturn = paymentReturnPath(location.state?.paymentReturn);
  if (isAuthenticated) return <Navigate to={authenticatedAuthRouteTarget({ approval: approval ?? paymentReturn, returnTo: location.state?.returnTo, pendingOAuth: peekPendingOAuth() })} replace />;
  return <><AuthNetworkChip />{children}</>;
}

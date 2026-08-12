// Minimal auth context (TQ-008). Backed by the backend's dev-token endpoint until a real
// OIDC/Identity Platform login flow replaces it (backend TQ-006). Token is kept in memory
// only — no localStorage/sessionStorage (also consistent with the artifact rules this
// scaffold's author follows elsewhere: avoid browser storage APIs for anything sensitive).
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { api } from "../lib/api";

interface AuthState {
  token: string | null;
  tenantId: string | null;
  email: string | null;
  role: string | null;
}

interface AuthContextValue extends AuthState {
  login: (input: { tenantId: string; email: string; role: string }) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    token: null,
    tenantId: null,
    email: null,
    role: null,
  });

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      isAuthenticated: state.token !== null,
      login: async (input) => {
        const { token } = await api.devLogin(input);
        setState({ token, tenantId: input.tenantId, email: input.email, role: input.role });
      },
      logout: () => setState({ token: null, tenantId: null, email: null, role: null }),
    }),
    [state]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth() must be used within an AuthProvider");
  return ctx;
}

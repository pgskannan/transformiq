import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { DataProfile } from "./pages/DataProfile";
import { Dashboard } from "./pages/Dashboard";
import { DevBootstrapTenant } from "./pages/DevBootstrapTenant";
import { Login } from "./pages/Login";
import { ProjectSetup } from "./pages/ProjectSetup";

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/projects/new" element={<ProjectSetup />} />
        <Route path="/projects/:projectId/data-profile" element={<DataProfile />} />
        {/* Dev-only tenant bootstrap route. import.meta.env.DEV is a Vite build-time
            constant that Rollup inlines as `false` in a production build; combined with
            dead-code elimination this route registration (and, since nothing else imports
            it, the DevBootstrapTenant module itself) is stripped from the production
            bundle rather than merely hidden behind a runtime check. */}
        {import.meta.env.DEV && (
          <Route path="/dev/bootstrap-tenant" element={<DevBootstrapTenant />} />
        )}
        <Route path="/" element={<Navigate to="/login" replace />} />
      </Routes>
    </AuthProvider>
  );
}

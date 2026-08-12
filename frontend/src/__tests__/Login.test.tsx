import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { Login } from "../pages/Login";

function renderLogin() {
  return render(
    <BrowserRouter>
      <AuthProvider>
        <Login />
      </AuthProvider>
    </BrowserRouter>
  );
}

describe("Login page", () => {
  it("renders the sign-in form", () => {
    renderLogin();
    expect(screen.getByText("TransformIQ")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/tenant id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/role/i)).toBeInTheDocument();
  });

  it("does not expose any tenant-creation control (that's a separate dev-only page now)", () => {
    renderLogin();
    expect(screen.queryByLabelText(/organization/i)).not.toBeInTheDocument();
  });
});

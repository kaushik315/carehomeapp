"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/rota";

  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Wrong password.");
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F1F3F1" }}>
      <form
        onSubmit={handleSubmit}
        style={{ background: "#fff", padding: 32, borderRadius: 12, width: 320, boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }}
      >
        <h1 style={{ fontSize: 18, marginBottom: 4 }}>Rota builder</h1>
        <p style={{ fontSize: 14, color: "#6E7A76", marginBottom: 20 }}>Enter the admin password to continue.</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #DCE0DC", fontSize: 15, marginBottom: 12 }}
        />
        {error && <p style={{ color: "#A8341F", fontSize: 13, marginBottom: 12 }}>{error}</p>}
        <button
          type="submit"
          disabled={loading || !password}
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 8,
            border: "none",
            background: "#1F6F5C",
            color: "#fff",
            fontSize: 15,
            cursor: loading || !password ? "not-allowed" : "pointer",
            opacity: loading || !password ? 0.6 : 1,
          }}
        >
          {loading ? "Checking…" : "Continue"}
        </button>
      </form>
    </div>
  );
}

export default function AdminLoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

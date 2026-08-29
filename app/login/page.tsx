"use client";

import { FormEvent, Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "../../lib/supabase/browser";

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return "/curation";
  }

  const target = new URL(value, window.location.origin);
  return target.origin === window.location.origin
    ? `${target.pathname}${target.search}${target.hash}`
    : "/curation";
}

export default function LoginPage() {
  const isStaticExport = process.env.GITHUB_PAGES === "1";

  if (isStaticExport) {
    return <main className="shell"><h1>Acceso de curación</h1><p>El panel privado está disponible en el despliegue de la aplicación.</p></main>;
  }

  return <Suspense fallback={<main className="shell"><p>Cargando acceso…</p></main>}><LoginForm /></Suspense>;
}

function LoginForm() {
  const searchParams = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email");
    if (typeof email !== "string" || !email.trim()) {
      setMessage("Introduce el correo autorizado.");
      return;
    }

    const returnTo = safeReturnTo(searchParams.get("return_to"));
    const callbackUrl = new URL("/auth/callback", window.location.origin);
    callbackUrl.searchParams.set("next", returnTo);
    const { error } = await createClient().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callbackUrl.toString() },
    });

    setMessage(
      error
        ? "No se pudo enviar el enlace. Inténtalo de nuevo."
        : "Revisa tu correo para abrir el enlace de acceso.",
    );
  }

  return (
    <main className="shell">
      <h1>Acceso de curación</h1>
      <p>Solicita un enlace mágico con el correo autorizado.</p>
      <form onSubmit={submit}>
        <label htmlFor="email">Correo electrónico</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <button type="submit">Enviar enlace</button>
      </form>
      {message ? <p role="status">{message}</p> : null}
    </main>
  );
}

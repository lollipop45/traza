import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/ui/Wordmark";

// Unknown addresses (and notFound()) for a signed-in visitor; signed-out visitors are sent to /login
// by the proxy first. Static: no user data.

export const metadata: Metadata = {
  title: "No encontrada · TRAZA",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-[480px] px-5 pt-[calc(env(safe-area-inset-top)+1.25rem)] pb-16 lg:max-w-[640px] lg:pt-12">
      <Wordmark />
      <h1 className="mt-11 text-[44px] leading-[1.02] font-light tracking-[-0.035em] lg:mt-24 lg:text-[64px]">No encontrada</h1>
      <p className="mt-2.5 max-w-[38ch] text-[15px] leading-[1.55] text-graphite">Esta dirección no existe en TRAZA.</p>
      <Link
        href="/"
        className="mt-6 inline-flex h-11 items-center rounded-md border border-charcoal/15 px-4 font-mono text-[11px] uppercase tracking-[0.14em] text-charcoal outline-none transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
      >
        Volver a Inicio
      </Link>
    </main>
  );
}

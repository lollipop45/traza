"use client";

// Unexpected errors while rendering a page: one restrained Spanish message. Nothing from the error
// is shown or logged here (in production Next.js only forwards a generic message and a digest; the
// details stay in the server logs).
import { Button } from "@/components/ui/Button";
import { Wordmark } from "@/components/ui/Wordmark";

export default function Error({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="mx-auto w-full max-w-[480px] px-5 pt-[calc(env(safe-area-inset-top)+1.25rem)] pb-16 lg:max-w-[640px] lg:pt-12">
      <Wordmark />
      <h1 className="mt-11 text-[44px] leading-[1.02] font-light tracking-[-0.035em] lg:mt-24 lg:text-[64px]">Algo ha fallado</h1>
      <p role="alert" className="mt-2.5 max-w-[38ch] text-[15px] leading-[1.55] text-graphite">
        No se ha podido completar. Inténtalo de nuevo en unos segundos.
      </p>
      <div className="mt-6">
        <Button variant="secondary" onClick={retry}>
          Reintentar
        </Button>
      </div>
    </main>
  );
}

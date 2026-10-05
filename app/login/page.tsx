import type { Metadata } from "next";
import { BlueprintBackdrop } from "@/components/ui/BlueprintBackdrop";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Wordmark } from "@/components/ui/Wordmark";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "Acceso · TRAZA",
  robots: { index: false, follow: false },
};

// Signed-in visitors are redirected to / by proxy.ts before this renders.
export default function LoginPage() {
  return (
    <main className="mx-auto w-full max-w-[480px] px-5 pt-[calc(env(safe-area-inset-top)+1.25rem)] pb-16 lg:max-w-[1080px] lg:px-14 lg:pt-12">
      <div className="relative isolate grid lg:grid-cols-12 lg:gap-x-14">
        <BlueprintBackdrop className="h-72 lg:h-[26rem]" />

        <div className="lg:col-span-5 lg:col-start-4">
          <div className="flex items-center justify-between">
            <Wordmark />
            <span className="font-mono text-[11px] tracking-[0.12em] text-graphite">ACCESO PRIVADO</span>
          </div>

          <h1 className="mt-11 text-[44px] leading-[1.02] font-light tracking-[-0.035em] lg:mt-24 lg:text-[64px]">
            Acceso
          </h1>
          <p className="mt-2.5 text-[15px] text-graphite lg:mt-3 lg:text-base">
            Tu espacio de trabajo, en un solo lugar.
          </p>

          <section aria-labelledby="credentials-heading" className="mt-10 lg:mt-14">
            <SectionHeader index="01" title="Credenciales" id="credentials-heading" />
            <div className="pt-6">
              <LoginForm />
            </div>
          </section>

          <p className="mt-10 border-t border-charcoal/10 pt-4 font-mono text-[10px] uppercase leading-[1.6] tracking-[0.14em] text-graphite">
            Aplicación personal · Sin registro público
          </p>
        </div>
      </div>
    </main>
  );
}

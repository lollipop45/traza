import type { ReactNode } from "react";
import { AppNavigation } from "./AppNavigation";

export function AppShell({
  activeHref,
  children,
}: {
  activeHref: string;
  children: ReactNode;
}) {
  return (
    <>
      <main className="pb-[calc(4rem+env(safe-area-inset-bottom)+3rem)] lg:pb-20 lg:pl-22">
        {/* Side padding never smaller than the safe area (iPhone in landscape, notch side). */}
        <div className="mx-auto w-full max-w-[480px] pt-[calc(env(safe-area-inset-top)+1.25rem)] pr-[max(1.25rem,env(safe-area-inset-right))] pl-[max(1.25rem,env(safe-area-inset-left))] md:max-w-[560px] lg:max-w-[1080px] lg:px-14 lg:pt-12">
          {children}
        </div>
      </main>
      <AppNavigation activeHref={activeHref} />
    </>
  );
}

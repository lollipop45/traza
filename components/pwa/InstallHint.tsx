"use client";

// A single quiet line on Home offering to install TRAZA: only when this browser can (Chromium's
// install prompt, or Safari on iPhone/iPad with its Share menu), never once installed, and hidden for
// 30 days on this device after "Ahora no". Never a modal, never shown on page load by the browser.
import { Download, X } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { INSTALL_HINT_STORAGE_KEY, installState, shouldShowInstallHint } from "@/lib/pwa/device";
import { promptInstall } from "@/lib/pwa/install-prompt";
import { useDisplayEnvironment, useInstallPrompt } from "@/lib/pwa/use-device";

function readDismissedAt(): number | null {
  try {
    const value = window.localStorage.getItem(INSTALL_HINT_STORAGE_KEY);
    return value === null ? null : Number(value);
  } catch {
    return null;
  }
}

const noop = () => () => undefined;

export function InstallHint() {
  const environment = useDisplayEnvironment();
  const prompt = useInstallPrompt();
  const storedDismissal = useSyncExternalStore(noop, readDismissedAt, () => null);
  const [dismissedNow, setDismissedNow] = useState(false);
  const [now] = useState(() => Date.now());

  if (!environment || dismissedNow || prompt === "installed") return null;
  const state = installState(environment, prompt === "available");
  if (!shouldShowInstallHint(state, storedDismissal, now)) return null;

  function dismiss() {
    setDismissedNow(true);
    try {
      window.localStorage.setItem(INSTALL_HINT_STORAGE_KEY, String(Date.now()));
    } catch {
      // Private mode: hidden for this visit only.
    }
  }

  return (
    <aside aria-label="Instalar TRAZA" className="flex items-start gap-3 border-y border-charcoal/10 py-3">
      <p className="min-w-0 flex-1 text-[13px] leading-[1.5] text-graphite">
        {state === "ios" ? (
          <>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-charcoal">Instalar TRAZA</span>
            <span className="mt-0.5 block">Compartir → Añadir a pantalla de inicio.</span>
          </>
        ) : (
          <>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-charcoal">TRAZA como app</span>
            <span className="mt-0.5 block">Ábrela desde tu escritorio o pantalla de inicio.</span>
          </>
        )}
      </p>
      {state === "prompt" && (
        <button
          type="button"
          onClick={() => void promptInstall()}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md border border-charcoal/15 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-charcoal outline-none transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
        >
          <Download aria-hidden className="size-4" strokeWidth={1.25} />
          Instalar
        </button>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Ahora no"
        title="Ahora no"
        className="grid size-11 shrink-0 place-items-center rounded-md text-graphite outline-none transition-colors hover:text-charcoal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
      >
        <X aria-hidden className="size-4" strokeWidth={1.25} />
      </button>
    </aside>
  );
}

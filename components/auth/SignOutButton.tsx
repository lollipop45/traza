import { LogOut } from "lucide-react";
import { signOut } from "@/lib/auth/actions";

/** Quiet session control for the page header. A plain form, so it works without client JavaScript. */
export function SignOutButton() {
  return (
    <form action={signOut} className="-my-2 flex">
      <button
        type="submit"
        title="Cerrar sesión"
        className="inline-flex h-8 items-center gap-2 rounded-md px-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite outline-none transition-colors hover:text-charcoal focus-visible:bg-paper focus-visible:text-charcoal"
      >
        <LogOut aria-hidden className="size-4" strokeWidth={1.25} />
        <span className="sr-only lg:not-sr-only">Cerrar sesión</span>
      </button>
    </form>
  );
}

"use client";

// Client Component only for the pending state, the inline error and the password visibility toggle.
// Authentication itself happens in the `signIn` Server Action.
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/Button";
import { signIn, type SignInState } from "@/lib/auth/actions";

const initialState: SignInState = { error: null, email: "" };

const fieldClass =
  "h-12 w-full rounded-[10px] border border-charcoal/15 bg-paper px-4 text-[16px] text-charcoal outline-none transition-colors placeholder:text-graphite/70 focus:border-charcoal/40";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(signIn, initialState);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <div>
        <label htmlFor="email" className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
          Correo electrónico
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          defaultValue={state.email}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "login-error" : undefined}
          className={`mt-2 ${fieldClass}`}
        />
      </div>

      <div>
        <label htmlFor="password" className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
          Contraseña
        </label>
        <div className="relative mt-2">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "login-error" : undefined}
            className={`${fieldClass} pr-12`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((visible) => !visible)}
            aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
            aria-pressed={showPassword}
            className="absolute inset-y-0 right-1 my-auto grid size-10 place-items-center rounded-md text-graphite outline-none transition-colors hover:text-charcoal focus-visible:bg-sand focus-visible:text-charcoal"
          >
            {showPassword ? (
              <EyeOff aria-hidden className="size-[18px]" strokeWidth={1.25} />
            ) : (
              <Eye aria-hidden className="size-[18px]" strokeWidth={1.25} />
            )}
          </button>
        </div>
      </div>

      {state.error && (
        <p id="login-error" role="alert" className="border-l border-charcoal pl-3 text-[14px] leading-[1.5] text-charcoal">
          {state.error}
        </p>
      )}

      <div className="mt-1">
        <Button variant="primary" size="block" type="submit" disabled={pending} icon={ArrowRight}>
          {pending ? "Entrando…" : "Entrar"}
        </Button>
      </div>
    </form>
  );
}

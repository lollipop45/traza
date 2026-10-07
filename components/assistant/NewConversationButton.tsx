"use client";

import { Plus } from "lucide-react";
import { useTransition } from "react";
import { startAssistantConversation } from "@/lib/assistant/actions";

/** Starts an empty conversation; the previous one stays stored. */
export function NewConversationButton() {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(async () => void (await startAssistantConversation()))}
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-charcoal outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:opacity-50"
    >
      <Plus aria-hidden className="size-3.5" strokeWidth={1.5} />
      Nueva
    </button>
  );
}

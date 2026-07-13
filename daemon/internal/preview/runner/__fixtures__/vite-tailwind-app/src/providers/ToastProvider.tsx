// Mirrors the real-world pattern that broke previews: a context hook that
// THROWS unless its provider is mounted above it in the tree.
import { createContext, useContext } from "react";

const ToastContext = createContext<((msg: string) => void) | null>(null);

export function ToastProvider({ children }: { children: any }) {
  return <ToastContext.Provider value={() => {}}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast requires a <ToastProvider> above it");
  return toast;
}

// NAMED export (no default) + context dependency — the ChatThread shape.
import { useToast } from "../providers/ToastProvider";

export function ThreadView() {
  useToast();
  return <div data-thread>thread ok</div>;
}

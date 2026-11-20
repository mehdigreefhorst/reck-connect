import type { PaneKind, SessionInfo } from "@proto/proto";
import type { HostRef } from "../host";
import { createSkeleton } from "./skeleton";

/**
 * What the user picked in the "New pane" dialog. `kind` is the pane kind to
 * spawn, or one of the two resume actions — `"resume-claude"` /
 * `"resume-codex"` — which the caller follows up with by calling
 * `pickSession()` and spawning a pane of the matching kind against the
 * chosen row. The two are separate because the identifiers differ: Claude
 * resumes by session id, Codex by slot id. `host` is the daemon the pane
 * will run on; the caller uses it to route `apiForHost(host)` calls and to
 * stamp `Tab.host` at creation.
 */
export type PaneKindChoice = {
  kind: PaneKind | "resume-claude" | "resume-codex";
  host: HostRef;
};

export interface AskPaneKindOptions {
  /**
   * Which hosts the user has enabled. A host that isn't enabled is
   * omitted entirely from the picker (single-host setups don't see the
   * host row at all — same look as pre-hybrid).
   */
  enabledHosts: { station: boolean; local: boolean };
  /**
   * Current ready state per host. The dialog mirrors
   * `isHostReady(host)` at open-time and re-reads via `subscribeReady`.
   */
  isHostReady: (host: HostRef) => boolean;
  /**
   * Live ready updates. Returns an unsubscribe fn; the dialog disposes
   * it on close. If omitted, the dialog uses the snapshot passed in
   * `isHostReady` and never re-renders — unit tests use this path.
   */
  subscribeReady?: (cb: (host: HostRef, ready: boolean) => void) => () => void;
}

/**
 * Modal dialog that asks which kind of pane to create (and, in hybrid
 * mode, on which host). Returns `null` if cancelled. In a single-host
 * setup the host row is suppressed and the returned `host` is whichever
 * host is enabled.
 *
 * Host selection gates the action buttons: a host whose `ready` flag is
 * false (station disconnected, or local pre-push-ack) renders its host
 * chip disabled and, if it was the selected host, also disables the
 * kind/resume buttons. Subscribing to `ready` transitions means a user
 * who opened the dialog just before local finished its first push sees
 * the local option light up without having to close and reopen.
 */
export function askPaneKind(
  parent: HTMLElement,
  opts: AskPaneKindOptions,
): Promise<PaneKindChoice | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "new-pane-dialog new-pane-composer";

    const enabled: HostRef[] = [];
    if (opts.enabledHosts.station) enabled.push("station");
    if (opts.enabledHosts.local) enabled.push("local");
    // Default selection: the first enabled host that's also ready, else
    // the first enabled host regardless (buttons will be disabled, but
    // the dialog still renders so the user can see the state).
    const initialReady = enabled.find((h) => opts.isHostReady(h));
    let selectedHost: HostRef = initialReady ?? enabled[0] ?? "station";

    const showHostRow = enabled.length >= 2;
    const hostRowHtml = showHostRow
      ? `
        <div class="dialog-host-label">Host</div>
        <div class="dialog-host-row">
          ${enabled
            .map(
              (h) => `
            <button class="host-chip" data-host="${h}" type="button">
              ${h === "station" ? "Station" : "Local"}
            </button>
          `,
            )
            .join("")}
        </div>`
      : "";

    overlay.innerHTML = `
      <div class="options" role="dialog" aria-label="New pane">
        <div class="dialog-title">New pane</div>
        ${hostRowHtml}
        <div class="dialog-buttons">
          <button class="primary" data-kind="claude">Claude Code</button>
          <button data-kind="shell">Shell</button>
          <button data-kind="codex">Codex</button>
          <button data-kind="resume-claude">Resume Claude…</button>
          <button data-kind="resume-codex">Resume Codex…</button>
        </div>
      </div>
    `;
    parent.appendChild(overlay);

    const chipEls = new Map<HostRef, HTMLButtonElement>();
    overlay.querySelectorAll<HTMLButtonElement>(".host-chip").forEach((el) => {
      const h = el.getAttribute("data-host") as HostRef;
      if (h === "station" || h === "local") chipEls.set(h, el);
    });
    const actionEls = Array.from(
      overlay.querySelectorAll<HTMLButtonElement>(".dialog-buttons button"),
    );

    function paint() {
      for (const [h, el] of chipEls) {
        const ready = opts.isHostReady(h);
        el.disabled = !ready;
        el.classList.toggle("selected", h === selectedHost);
        el.classList.toggle("disabled", !ready);
        el.title = ready
          ? ""
          : h === "local"
            ? "Local daemon not ready yet"
            : "Station not connected";
      }
      const hostReady = opts.isHostReady(selectedHost);
      for (const el of actionEls) el.disabled = !hostReady;
    }

    paint();

    const unsubscribe = opts.subscribeReady
      ? opts.subscribeReady((host, ready) => {
          // If the selected host just became not-ready and another host
          // is enabled+ready, flip the selection so the user's next
          // keypress doesn't silently no-op. Otherwise keep whatever
          // they picked; paint() will disable the actions accordingly.
          if (host === selectedHost && !ready) {
            const alt = enabled.find((h) => h !== selectedHost && opts.isHostReady(h));
            if (alt) selectedHost = alt;
          }
          paint();
        })
      : null;

    const close = (result: PaneKindChoice | null) => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      unsubscribe?.();
      resolve(result);
    };

    // Keep kind-action behaviour: a kind keyboard shortcut only fires
    // when the currently selected host is ready. "h" toggles host in
    // hybrid mode (no-op in single-host setups).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(null);
        return;
      }
      if (e.key.toLowerCase() === "h" && showHostRow) {
        e.preventDefault();
        e.stopPropagation();
        const others = enabled.filter((h) => h !== selectedHost);
        if (others.length > 0) {
          selectedHost = others[0];
          paint();
        }
        return;
      }
      if (!opts.isHostReady(selectedHost)) return;
      // Shift+R = Resume Codex. Checked before the lowercased branches so
      // "r" can't shadow it, and gated on shiftKey so a CapsLock user
      // pressing plain "r" still lands on Resume Claude.
      if (e.key === "R" && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        close({ kind: "resume-codex", host: selectedHost });
        return;
      }
      if (e.key === "Enter" || e.key.toLowerCase() === "c") {
        e.preventDefault();
        e.stopPropagation();
        close({ kind: "claude", host: selectedHost });
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        close({ kind: "shell", host: selectedHost });
      } else if (e.key.toLowerCase() === "x") {
        // "x" for codeX (c/s/r are taken). Availability is handled by the
        // create flow (a toast explains if the host has no codex binary),
        // so the shortcut always resolves like the other kinds.
        e.preventDefault();
        e.stopPropagation();
        close({ kind: "codex", host: selectedHost });
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        e.stopPropagation();
        close({ kind: "resume-claude", host: selectedHost });
      }
    };
    window.addEventListener("keydown", onKey, true);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });

    for (const [h, el] of chipEls) {
      el.addEventListener("click", () => {
        if (el.disabled) return;
        selectedHost = h;
        paint();
      });
    }

    for (const el of actionEls) {
      el.addEventListener("click", () => {
        if (el.disabled) return;
        const kind = el.getAttribute("data-kind") as PaneKindChoice["kind"];
        close({ kind, host: selectedHost });
      });
    }

    const primary = overlay.querySelector<HTMLElement>(
      ".dialog-buttons button.primary:not([disabled])",
    );
    primary?.focus();
  });
}

/**
 * Relative-time string for session rows. Intentionally rough — the
 * label just needs to let the user tell sessions apart at a glance.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const deltaSec = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (deltaSec < 60) return "just now";
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Rows drawn while the session list is still loading. */
const SESSION_SKELETON_ROWS = 5;

function sessionRowHtml(s: SessionInfo, index: number): string {
  const shortId = (s.session_id || s.slot_id || "").slice(0, 8);
  // Prefer the resolved label (manual tab name, else Claude's
  // /rename title). Older daemons don't send it, and unnamed
  // sessions have none — both fall back to the spawn-time seed.
  const label = s.display_name?.trim();
  // With a real label the short id is the only thing that tells
  // two same-named sessions apart; the seed already ends in it.
  const idHtml = label && shortId
    ? `<span class="session-id">${escapeHtml(shortId)}</span>`
    : "";
  return `
          <button class="session-row" data-idx="${index}" role="option">
            <span class="session-name">${escapeHtml(label || s.name || shortId)}</span>
            <span class="session-meta">${idHtml}<span class="session-time">${escapeHtml(relativeTime(s.last_active_at))}</span></span>
          </button>`;
}

function sessionListHtml(sessions: SessionInfo[]): string {
  if (sessions.length === 0) {
    return `<div class="dialog-body" style="opacity:0.7;">No past sessions for this project yet.</div>`;
  }
  return `<div class="session-list" role="listbox">${sessions.map(sessionRowHtml).join("")}</div>`;
}

function sessionLoadErrorHtml(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `<div class="dialog-body session-load-error" role="alert">Couldn't load sessions: ${escapeHtml(detail)}</div>`;
}

/**
 * Modal that lists the persisted sessions for a project and resolves
 * with the one the user picks. Empty list → renders a "nothing to
 * resume" state with just a Back button. Null resolve = cancelled.
 *
 * `sessions` may be a promise: the dialog then opens at once with a
 * skeleton and fills in when the list arrives (issue #182), instead of
 * the click looking dead until the fetch returns. A rejected promise
 * shows the error in the dialog; cancelling while loading resolves null
 * and the late result is ignored.
 */
export function pickSession(
  parent: HTMLElement,
  sessions: SessionInfo[] | Promise<SessionInfo[]>,
): Promise<SessionInfo | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "new-pane-dialog";
    overlay.innerHTML = `
      <div class="options session-picker" role="dialog" aria-label="Resume session">
        <div class="dialog-title">Resume a session</div>
        <div class="session-picker-content"></div>
        <div class="dialog-buttons" style="margin-top:1rem;">
          <button class="primary" data-action="cancel">Back</button>
        </div>
      </div>
    `;
    parent.appendChild(overlay);
    const content = overlay.querySelector<HTMLElement>(".session-picker-content")!;
    const cancelBtn = overlay.querySelector<HTMLButtonElement>('button[data-action="cancel"]');

    let closed = false;
    const close = (result: SessionInfo | null) => {
      if (closed) return;
      closed = true;
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
    };
    window.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    cancelBtn?.addEventListener("click", () => close(null));

    const showSessions = (list: SessionInfo[]) => {
      content.innerHTML = sessionListHtml(list);
      content.querySelectorAll<HTMLButtonElement>(".session-row").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.getAttribute("data-idx"));
          close(list[idx] ?? null);
        });
      });
      (content.querySelector<HTMLElement>(".session-row") ?? cancelBtn)?.focus();
    };

    if (Array.isArray(sessions)) {
      showSessions(sessions);
      return;
    }
    // Skeleton sits inside a `.session-list` so the dialog is already the
    // height the real list will roughly take — no jump when it fills in.
    const loading = document.createElement("div");
    loading.className = "session-list";
    loading.appendChild(
      createSkeleton({ rows: SESSION_SKELETON_ROWS, label: "Loading sessions" }),
    );
    content.appendChild(loading);
    cancelBtn?.focus();
    sessions.then(
      (list) => {
        if (!closed) showSessions(list);
      },
      (err: unknown) => {
        if (closed) return;
        content.innerHTML = sessionLoadErrorHtml(err);
        cancelBtn?.focus();
      },
    );
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Yes/No confirmation with a danger-tinted primary button. Returns true if the user confirmed. */
export function confirmDialog(
  parent: HTMLElement,
  opts: { title: string; body: string; confirmLabel: string; cancelLabel?: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "new-pane-dialog";
    overlay.innerHTML = `
      <div class="options" role="alertdialog" aria-label="${escapeHtml(opts.title)}" style="max-width:440px;">
        <div class="dialog-title">${escapeHtml(opts.title)}</div>
        <div class="dialog-body">${escapeHtml(opts.body)}</div>
        <div class="dialog-buttons">
          <button data-action="cancel">${escapeHtml(opts.cancelLabel ?? "Cancel")}</button>
          <button class="danger" data-action="confirm">${escapeHtml(opts.confirmLabel)}</button>
        </div>
      </div>
    `;
    parent.appendChild(overlay);

    const close = (result: boolean) => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(true); }
    };
    window.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    overlay.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      btn.addEventListener("click", () => close(btn.getAttribute("data-action") === "confirm"));
    });
    (overlay.querySelector("button.danger") as HTMLElement)?.focus();
  });
}

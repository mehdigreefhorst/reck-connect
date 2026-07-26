// Quota polling settings for the usage view's gear button (#98). How
// often the station reads account quota, and whether it does at all.
//
// Chrome reuses the app's existing modal vocabulary (.confirm-overlay /
// .confirm-card / .confirm-btn) rather than introducing a second dialog
// look — see reuse-shared-components. The root MUST carry .confirm-overlay:
// confirmDialogOpen() is a query for that class, and it is what stops the
// usage view's Escape handler from closing the whole view out from under
// this dialog. Both switches are the shared slidingSwitch component, and
// all option logic lives in usage-poll.ts so it can be tested without a
// DOM; this file is wiring.

import type { ApiClient, UsagePollSettings } from "@client-core/api/client";
import { createSlidingSwitch } from "./slidingSwitch";
import {
  buildPollSettings,
  describePollSettings,
  splitInterval,
  type IntervalUnit,
  type PollBounds,
} from "./usage-poll";

export interface UsagePollDialogOpts {
  api: ApiClient;
}

/** Opens the polling dialog. Resolves when it closes, with true if a new
 *  setting was saved — the caller may want to reflect it. */
export function openUsagePollDialog(opts: UsagePollDialogOpts): Promise<boolean> {
  return new Promise((resolve) => {
    let busy = false;
    let saved = false;

    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-card usage-poll-card" role="dialog" aria-modal="true" aria-label="Quota polling">
        <div class="confirm-title">Quota polling</div>
        <div class="confirm-detail">How often the station reads your 5h and 7d quota.</div>

        <div class="usage-poll-form">
          <div class="usage-poll-switches"></div>
          <div class="usage-poll-interval">
            <label class="usage-export-field usage-poll-amount">
              <span>Every</span>
              <input type="number" class="usage-poll-input" inputmode="numeric" min="1" step="1" />
            </label>
            <div class="usage-poll-unit"></div>
          </div>
        </div>

        <div class="usage-poll-summary"></div>
        <div class="usage-export-status" role="status"></div>

        <div class="confirm-actions">
          <button type="button" class="confirm-btn confirm-btn-ghost usage-poll-cancel">Cancel</button>
          <button type="button" class="confirm-btn confirm-btn-primary usage-poll-save">Save</button>
        </div>
      </div>
    `;

    const q = <T extends HTMLElement>(sel: string): T => overlay.querySelector(sel) as T;
    const switchesEl = q<HTMLElement>(".usage-poll-switches");
    const unitEl = q<HTMLElement>(".usage-poll-unit");
    const intervalEl = q<HTMLElement>(".usage-poll-interval");
    const amountInput = q<HTMLInputElement>(".usage-poll-input");
    const summaryEl = q<HTMLElement>(".usage-poll-summary");
    const statusEl = q<HTMLElement>(".usage-export-status");
    const saveBtn = q<HTMLButtonElement>(".usage-poll-save");
    const cancelBtn = q<HTMLButtonElement>(".usage-poll-cancel");

    // Until the daemon answers, its clamp is unknown; these are only ever
    // used to render, never to decide, and are replaced on load.
    let bounds: PollBounds = { minIntervalSec: 5, maxIntervalSec: 86_400 };

    const pollingSwitch = createSlidingSwitch<"off" | "on">({
      label: "Polling",
      options: [
        { value: "off", label: "Off" },
        { value: "on", label: "On" },
      ],
      value: "on",
      onChange: () => {
        applyEnabledState();
        refreshSummary();
      },
    });
    switchesEl.appendChild(pollingSwitch.el);

    const unitSwitch = createSlidingSwitch<IntervalUnit>({
      // No visible caption: the row reads "Every [30] [sec|min]" as one
      // phrase, and a "UNIT" label above the switch breaks it in half to
      // say something the two options already say. Kept as the accessible
      // name so it is still announced.
      label: "",
      ariaLabel: "Interval unit",
      options: [
        { value: "sec", label: "sec" },
        { value: "min", label: "min" },
      ],
      value: "sec",
      onChange: refreshSummary,
    });
    unitEl.appendChild(unitSwitch.el);

    function currentValues() {
      return {
        enabled: pollingSwitch.value() === "on",
        amount: amountInput.value,
        unit: unitSwitch.value(),
      };
    }

    /** Off dims the interval row but keeps its value, so turning polling
     *  back on restores the period rather than resetting it. */
    function applyEnabledState(): void {
      const on = pollingSwitch.value() === "on";
      intervalEl.classList.toggle("is-disabled", !on);
      amountInput.disabled = !on;
      unitSwitch.setDisabled(!on);
    }

    function refreshSummary(): void {
      const built = buildPollSettings(currentValues(), bounds);
      if (!built.ok) {
        // Don't claim a cost for a value that won't be saved.
        summaryEl.textContent = built.error;
        return;
      }
      summaryEl.textContent = describePollSettings(built.settings);
    }

    function setStatus(text: string, kind: "error" | "info" | "" = ""): void {
      statusEl.textContent = text;
      statusEl.classList.toggle("is-error", kind === "error");
    }

    function showSettings(s: UsagePollSettings): void {
      const { amount, unit } = splitInterval(s.intervalSec);
      amountInput.value = String(amount);
      unitSwitch.set(unit);
      pollingSwitch.set(s.enabled ? "on" : "off");
      applyEnabledState();
      refreshSummary();
    }

    amountInput.addEventListener("input", refreshSummary);

    // --- load ---------------------------------------------------------
    setStatus("Loading…", "info");
    saveBtn.disabled = true;
    void opts.api
      .getUsagePollSettings()
      .then((s) => {
        bounds = { minIntervalSec: s.minIntervalSec, maxIntervalSec: s.maxIntervalSec };
        amountInput.min = String(s.minIntervalSec);
        showSettings(s);
        setStatus("");
        saveBtn.disabled = false;
      })
      .catch((err: unknown) => {
        // A station without telemetry 404s here. Say what that means
        // rather than showing a status code.
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(
          msg.includes("404")
            ? "Usage tracking is not enabled on this station."
            : `Couldn't load the current setting: ${msg}`,
          "error",
        );
      });

    // --- save ---------------------------------------------------------
    async function save(): Promise<void> {
      if (busy || saveBtn.disabled) return;
      const built = buildPollSettings(currentValues(), bounds);
      if (!built.ok) {
        setStatus(built.error, "error");
        return;
      }

      busy = true;
      saveBtn.disabled = true;
      setStatus("Saving…", "info");
      try {
        // The daemon echoes what it accepted, which is what takes effect —
        // show that rather than what was typed.
        const applied = await opts.api.putUsagePollSettings(built.settings);
        showSettings(applied);
        saved = true;
        close();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`Couldn't save: ${msg}`, "error");
      } finally {
        busy = false;
        saveBtn.disabled = false;
      }
    }

    // --- lifecycle ----------------------------------------------------
    let done = false;
    function close(): void {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(saved);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      } else if (e.key === "Enter" && !busy) {
        // Arrow keys belong to whichever switch has focus; Enter on one of
        // them toggles it rather than submitting.
        if ((e.target as HTMLElement | null)?.classList.contains("slide-switch-opt")) return;
        e.stopPropagation();
        void save();
      }
    }

    overlay.addEventListener("pointerdown", (e) => {
      // Don't let a mid-save backdrop click strand an in-flight request.
      if (e.target === overlay && !busy) close();
    });
    cancelBtn.addEventListener("click", () => close());
    saveBtn.addEventListener("click", () => void save());
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(overlay);
    amountInput.focus();
  });
}

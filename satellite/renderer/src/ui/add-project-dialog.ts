import { ApiClient } from "@client-core/api/client";
import type { Project } from "@proto/proto";
import { defaultNameFromRemote, parseGitRemote } from "./git-remote-url";

export type DialogResult =
  | { kind: "new"; name: string; preamble: string }
  | { kind: "existing"; cwd: string; name: string; preamble: string }
  | { kind: "clone"; url: string; name: string; preamble: string }
  | null;

// Vite inlines `import.meta.env.VITE_RECK_STATION_ROOT` at build time.
// Required — see `project-push.ts` for the full rationale.
const REMOTE_PROJECTS_ROOT: string = (() => {
  const v = (import.meta.env as Record<string, string | undefined>).VITE_RECK_STATION_ROOT;
  if (!v) throw new Error("VITE_RECK_STATION_ROOT is required at build time (Vite env)");
  return v;
})();

/** Slugify a project name the same way the daemon does:
 *  lowercase → non-[a-z0-9] runs become '-' → trim leading/trailing '-'. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || ""
  );
}

/** Runs the add-project flow. Defaults to name-first (daemon picks cwd);
 *  the user can opt into the folder picker via the secondary button, or
 *  paste a git URL to clone. Both of those fill a station directory the
 *  Satellite reserves first, then register the station-side path with the
 *  daemon — never the laptop one. */
export async function addProjectFlow(client: ApiClient): Promise<Project | null> {
  const picked = await promptAddProject();
  if (picked === null) return null;

  try {
    if (picked.kind === "existing") {
      return await copyAndRegisterExisting(client, picked);
    }
    if (picked.kind === "clone") {
      return await cloneAndRegister(client, picked);
    }
    const body: { name: string; preamble?: string } = { name: picked.name };
    if (picked.preamble) body.preamble = picked.preamble;
    const resp = await client.createProject(body);
    return resp.project;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await alertError(`Failed to add project: ${msg}`);
    return null;
  }
}

async function copyAndRegisterExisting(
  client: ApiClient,
  picked: { cwd: string; name: string; preamble: string },
): Promise<Project | null> {
  const slug = slugify(picked.name);
  if (!slug) {
    await alertError("Project name must contain at least one letter or digit.");
    return null;
  }

  const cancelFlag = { canceled: false };
  const overlay = showCopyProgress(picked.cwd, slug, async () => {
    cancelFlag.canceled = true;
    await window.reckAPI.rsync.cancel();
  });

  // an audit finding — collision detection lives inside `toStation` now
  // (atomic `mkdir` reservation on the station). A colliding slug surfaces
  // here as `result.code === "slug-in-use"` and is reported with the same
  // user-visible wording the old preflight used.
  const result = await window.reckAPI.rsync.toStation(picked.cwd, slug);
  overlay.remove();

  if (!result.ok) {
    if (result.code === "slug-in-use") {
      await alertError(
        `A folder already exists on the station at ${REMOTE_PROJECTS_ROOT}/${slug}.\n\nChoose a different name.`,
      );
      return null;
    }
    // For non-collision failures the main process has already rolled back
    // (if a reservation existed) before resolving — calling rollback again
    // here is harmless (it's `rm -rf` of a now-missing dir) and keeps the
    // cancel/error UX exactly as it was for users on older builds.
    await window.reckAPI.rsync.rollback(slug);
    if (!cancelFlag.canceled) {
      await alertError(`Copy failed: ${result.error}`);
    }
    return null;
  }

  return registerFilledSlug(client, picked, slug, "Copied files");
}

/**
 * Clone a repository into a fresh station directory, then register it.
 *
 * The station does the cloning (`main/git-clone.ts` over the same SSH
 * transport rsync uses), so the repo never round-trips through the laptop and
 * `origin` survives. The shape is deliberately identical to the rsync flow:
 * reserve the slug, fill it, register it, roll back on any failure.
 */
async function cloneAndRegister(
  client: ApiClient,
  picked: { url: string; name: string; preamble: string },
): Promise<Project | null> {
  const slug = slugify(picked.name);
  if (!slug) {
    await alertError("Project name must contain at least one letter or digit.");
    return null;
  }

  const cancelFlag = { canceled: false };
  const overlay = showCloneProgress(picked.url, slug, async () => {
    cancelFlag.canceled = true;
    await window.reckAPI.git.cancel();
  });

  const result = await window.reckAPI.git.clone(picked.url, slug);
  overlay.remove();

  if (!result.ok) {
    if (result.code === "slug-in-use") {
      await alertError(
        `A folder already exists on the station at ${REMOTE_PROJECTS_ROOT}/${slug}.\n\nChoose a different name.`,
      );
      return null;
    }
    // Every other failure path already rolled the reservation back in the
    // main process; a second rollback is a no-op `rm -rf` of a missing dir.
    await window.reckAPI.rsync.rollback(slug);
    if (!cancelFlag.canceled) {
      await alertError(result.error);
    }
    return null;
  }

  return registerFilledSlug(client, picked, slug, "Cloned the repository");
}

/**
 * Register a station directory this flow just filled (rsync or clone) with
 * the daemon. Shared so the two flows can't drift on the rollback contract:
 * if registration fails the directory must go, or the slug stays taken with
 * nothing to show for it.
 */
async function registerFilledSlug(
  client: ApiClient,
  picked: { name: string; preamble: string },
  slug: string,
  whatSucceeded: string,
): Promise<Project | null> {
  try {
    const remoteCwd = `${REMOTE_PROJECTS_ROOT}/${slug}`;
    const body: { name: string; cwd: string; id: string; preamble?: string } = {
      name: picked.name,
      cwd: remoteCwd,
      id: slug,
    };
    if (picked.preamble) body.preamble = picked.preamble;
    const resp = await client.createProject(body);
    return resp.project;
  } catch (e: unknown) {
    await window.reckAPI.rsync.rollback(slug);
    const msg = e instanceof Error ? e.message : String(e);
    await alertError(`${whatSucceeded}, but registration failed: ${msg}`);
    return null;
  }
}

function showCopyProgress(
  localPath: string,
  slug: string,
  onCancel: () => void,
): { remove: () => void } {
  const overlay = document.createElement("div");
  overlay.className = "new-pane-dialog";
  overlay.innerHTML = `
    <div class="options" role="dialog" aria-label="Copying to station" style="max-width:480px;">
      <div class="dialog-title">Copying to station</div>
      <div class="dialog-body" style="margin-top:12px;">
        <div style="font-size:12px; opacity:0.8; margin-bottom:8px;">
          ${escapeHtml(localPath)} → ${REMOTE_PROJECTS_ROOT}/${escapeHtml(slug)}
        </div>
        <div style="height:6px; background:rgba(0,0,0,0.1); border-radius:3px; overflow:hidden;">
          <div id="ap-progress-fill" style="height:100%; width:0%; background:var(--accent, #5b8def); transition:width 0.15s ease;"></div>
        </div>
        <div id="ap-progress-text" style="margin-top:10px; font-size:11px; opacity:0.75; font-variant-numeric:tabular-nums;">
          Preparing…
        </div>
      </div>
      <div class="dialog-buttons" style="margin-top:16px; display:flex; gap:8px; justify-content:flex-end;">
        <button id="ap-cancel-copy" type="button">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const fill = overlay.querySelector("#ap-progress-fill") as HTMLElement;
  const text = overlay.querySelector("#ap-progress-text") as HTMLElement;
  window.reckAPI.rsync.onProgress((p) => {
    fill.style.width = `${p.percent}%`;
    const mb = (p.bytes / 1024 / 1024).toFixed(1);
    text.textContent = `${p.percent}% • ${mb} MB • ${p.speed} • ETA ${p.eta}`;
  });

  (overlay.querySelector("#ap-cancel-copy") as HTMLElement).addEventListener("click", onCancel);
  return { remove: () => overlay.remove() };
}

/**
 * The clone's progress overlay. Same furniture as the copy one, but git
 * reports a phase and a percentage rather than bytes/ETA — "Receiving
 * objects" is most of the wall-clock, "Resolving deltas" the tail.
 */
function showCloneProgress(
  url: string,
  slug: string,
  onCancel: () => void,
): { remove: () => void } {
  const overlay = document.createElement("div");
  overlay.className = "new-pane-dialog";
  overlay.innerHTML = `
    <div class="options" role="dialog" aria-label="Cloning to station" style="max-width:480px;">
      <div class="dialog-title">Cloning to station</div>
      <div class="dialog-body" style="margin-top:12px;">
        <div style="font-size:12px; opacity:0.8; margin-bottom:8px;">
          ${escapeHtml(url)} → ${REMOTE_PROJECTS_ROOT}/${escapeHtml(slug)}
        </div>
        <div style="height:6px; background:rgba(0,0,0,0.1); border-radius:3px; overflow:hidden;">
          <div id="ap-clone-fill" style="height:100%; width:0%; background:var(--accent, #5b8def); transition:width 0.15s ease;"></div>
        </div>
        <div id="ap-clone-text" style="margin-top:10px; font-size:11px; opacity:0.75; font-variant-numeric:tabular-nums;">
          Contacting the repository…
        </div>
      </div>
      <div class="dialog-buttons" style="margin-top:16px; display:flex; gap:8px; justify-content:flex-end;">
        <button id="ap-cancel-clone" type="button">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const fill = overlay.querySelector("#ap-clone-fill") as HTMLElement;
  const text = overlay.querySelector("#ap-clone-text") as HTMLElement;
  window.reckAPI.git.onProgress((p) => {
    fill.style.width = `${p.percent}%`;
    text.textContent = `${p.phase} — ${p.percent}%`;
  });

  (overlay.querySelector("#ap-cancel-clone") as HTMLElement).addEventListener("click", onCancel);
  return { remove: () => overlay.remove() };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/**
 * The Add-a-project dialog. Exported for tests: the three outcomes (empty URL
 * ⇒ a fresh empty project, a git URL ⇒ clone, the folder picker ⇒ rsync) are
 * the contract `addProjectFlow` branches on.
 */
export function promptAddProject(): Promise<DialogResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "new-pane-dialog";
    overlay.innerHTML = `
      <div class="options" role="dialog" aria-label="Add a project" style="max-width:480px;">
        <div class="dialog-title">Add a project</div>
        <div class="dialog-body" style="margin-top:12px;">
          <label for="ap-name" style="display:block; font-size:12px; opacity:0.8;">Name</label>
          <input id="ap-name" type="text" class="text-input" placeholder="demo" />
          <label for="ap-url" style="display:block; margin-top:12px; font-size:12px; opacity:0.8;">Git URL (optional) — the station clones it into the new project</label>
          <input id="ap-url" type="text" class="text-input" placeholder="https://github.com/owner/repo" />
          <div id="ap-url-error" style="margin-top:6px; font-size:11px; color:var(--sl-red, #c0392b); display:none;"></div>
          <label for="ap-preamble" style="display:block; margin-top:12px; font-size:12px; opacity:0.8;">Preamble (optional) — appended to the agent's system prompt (Claude &amp; Codex) on every session</label>
          <textarea id="ap-preamble" class="text-input" rows="4" style="margin-top:6px; resize:vertical; font-family:inherit;"></textarea>
          <div style="margin-top:14px; font-size:11px; opacity:0.65; line-height:1.4;">
            A new folder will be created at <code>~/reck/projects/&lt;slug&gt;</code> on the station — empty, or a clone of the URL above. To copy an existing laptop folder to the station instead, use the secondary button below.
          </div>
        </div>
        <div class="dialog-buttons" style="margin-top:16px; display:flex; gap:8px; justify-content:flex-end; align-items:center;">
          <button id="ap-existing" type="button">From existing folder…</button>
          <div style="flex:1;"></div>
          <button id="ap-cancel" type="button">Cancel</button>
          <button id="ap-ok" class="primary" type="button">Create</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const nameInput = overlay.querySelector("#ap-name") as HTMLInputElement;
    const urlInput = overlay.querySelector("#ap-url") as HTMLInputElement;
    const urlError = overlay.querySelector("#ap-url-error") as HTMLElement;
    const preambleInput = overlay.querySelector("#ap-preamble") as HTMLTextAreaElement;
    requestAnimationFrame(() => nameInput.focus());

    // Prefill the name from the repo, but stop the moment the user takes
    // the field over — their name always wins.
    let nameTouched = false;
    nameInput.addEventListener("input", () => {
      nameTouched = true;
    });
    urlInput.addEventListener("input", () => {
      urlError.style.display = "none";
      if (nameTouched) return;
      const remote = parseGitRemote(urlInput.value);
      nameInput.value = remote ? defaultNameFromRemote(remote) : "";
    });

    const finish = (result: DialogResult) => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const submitNew = () => {
      const rawUrl = urlInput.value.trim();
      const remote = rawUrl === "" ? null : parseGitRemote(rawUrl);
      if (rawUrl !== "" && remote === null) {
        // Stay in the dialog: a typo'd URL should be fixable in place, not
        // reported after the flow has already committed to a slug.
        urlError.textContent = "Not a git repository URL.";
        urlError.style.display = "block";
        urlInput.focus();
        return;
      }
      const name = nameInput.value.trim() || (remote ? defaultNameFromRemote(remote) : "");
      if (!name) {
        nameInput.focus();
        return;
      }
      const preamble = preambleInput.value.trim();
      finish(
        remote
          ? { kind: "clone", url: remote.url, name, preamble }
          : { kind: "new", name, preamble },
      );
    };
    const submitExisting = async () => {
      const cwd = await window.reckAPI.dialog.pickFolder();
      if (!cwd) return; // user canceled picker — stay in dialog
      const basename = cwd.split("/").filter(Boolean).pop() ?? "project";
      const name = nameInput.value.trim() || basename;
      finish({
        kind: "existing",
        cwd,
        name,
        preamble: preambleInput.value.trim(),
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.target === nameInput || e.target === urlInput)) {
        e.preventDefault();
        e.stopPropagation();
        submitNew();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    (overlay.querySelector("#ap-ok") as HTMLElement).addEventListener("click", submitNew);
    (overlay.querySelector("#ap-existing") as HTMLElement).addEventListener(
      "click",
      () => void submitExisting(),
    );
    (overlay.querySelector("#ap-cancel") as HTMLElement).addEventListener("click", () =>
      finish(null),
    );
  });
}

function alertError(message: string): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "new-pane-dialog";
    overlay.innerHTML = `
      <div class="options" role="alertdialog" aria-label="Error" style="max-width:440px;">
        <div class="dialog-title">Could not add project</div>
        <div class="dialog-body"></div>
        <div class="dialog-buttons">
          <button id="ap-err-ok" class="primary" type="button">OK</button>
        </div>
      </div>
    `;
    (overlay.querySelector(".dialog-body") as HTMLElement).textContent = message;
    document.body.appendChild(overlay);
    const close = () => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    (overlay.querySelector("#ap-err-ok") as HTMLElement).addEventListener("click", close);
    (overlay.querySelector("#ap-err-ok") as HTMLElement).focus();
  });
}

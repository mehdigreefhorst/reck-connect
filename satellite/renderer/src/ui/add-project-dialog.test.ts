// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { promptAddProject, showCloneProgress, slugify } from "./add-project-dialog";

describe("slugify", () => {
  it("lowercases letters", () => {
    expect(slugify("Demo")).toBe("demo");
  });

  it("collapses non-alphanumeric runs to a single dash", () => {
    expect(slugify("My  Cool   Project!!!")).toBe("my-cool-project");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("  --hello--  ")).toBe("hello");
  });

  it("returns empty string for names with no alphanumerics", () => {
    expect(slugify("   ")).toBe("");
    expect(slugify("!!!")).toBe("");
  });

  it("preserves digits", () => {
    expect(slugify("Project 42")).toBe("project-42");
  });

  it("matches the daemon's derivation for common cases", () => {
    // These mirror cases from daemon/internal/config/slugify_test.go.
    expect(slugify("Reck Connect")).toBe("reck-connect");
    expect(slugify("CLV5")).toBe("clv5");
    expect(slugify("my/cool/repo")).toBe("my-cool-repo");
  });
});

// The dialog's contract is which DialogResult it produces (#162). The flow
// branches on `kind`, so these are the cases that decide whether the station
// clones, rsyncs, or just mkdirs.
describe("promptAddProject", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const el = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("returns kind:new when the URL field is empty", async () => {
    const pending = promptAddProject();
    type(el<HTMLInputElement>("#ap-name"), "Demo");
    el<HTMLElement>("#ap-ok").click();
    await expect(pending).resolves.toEqual({ kind: "new", name: "Demo", preamble: "" });
  });

  it("returns kind:clone with the normalised URL when one is given", async () => {
    const pending = promptAddProject();
    type(el<HTMLInputElement>("#ap-url"), "octocat/Hello-World");
    el<HTMLElement>("#ap-ok").click();
    await expect(pending).resolves.toEqual({
      kind: "clone",
      url: "https://github.com/octocat/Hello-World",
      name: "Hello-World",
      preamble: "",
    });
  });

  it("prefills the name from the repo, but never overwrites a typed name", async () => {
    const pending = promptAddProject();
    const name = el<HTMLInputElement>("#ap-name");
    type(name, "My Own Name");
    type(el<HTMLInputElement>("#ap-url"), "https://github.com/octocat/Hello-World.git");
    expect(name.value).toBe("My Own Name");
    el<HTMLElement>("#ap-ok").click();
    await expect(pending).resolves.toMatchObject({ kind: "clone", name: "My Own Name" });
  });

  it("keeps the dialog open and shows an error for an unusable URL", async () => {
    let settled = false;
    const pending = promptAddProject().then((r) => {
      settled = true;
      return r;
    });
    type(el<HTMLInputElement>("#ap-url"), "ext::sh -c 'curl x|sh'");
    el<HTMLElement>("#ap-ok").click();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(el<HTMLElement>("#ap-url-error").style.display).toBe("block");
    expect(document.querySelector("#ap-url")).not.toBeNull();
    // Clean up the still-open dialog so the promise doesn't dangle.
    el<HTMLElement>("#ap-cancel").click();
    await expect(pending).resolves.toBeNull();
  });

  it("cancels to null", async () => {
    const pending = promptAddProject();
    el<HTMLElement>("#ap-cancel").click();
    await expect(pending).resolves.toBeNull();
  });
});

// The overlay is rebuilt for every Add-Project flow, so its IPC subscription
// has to go when it does — otherwise each run leaves a listener alive holding
// a detached overlay, and every past overlay is written to on the next clone.
describe("showCloneProgress", () => {
  it("drops its progress subscription when the overlay is removed", () => {
    const listeners: Array<(p: { percent: number; phase: string }) => void> = [];
    let unsubscribed = 0;
    (window as unknown as { reckAPI: unknown }).reckAPI = {
      git: {
        onProgress: (cb: (p: { percent: number; phase: string }) => void) => {
          listeners.push(cb);
          return () => {
            unsubscribed += 1;
          };
        },
      },
    };

    const overlay = showCloneProgress("https://github.com/a/b", "b", () => {});
    expect(listeners.length).toBe(1);
    listeners[0]({ percent: 40, phase: "Receiving objects" });
    expect((document.querySelector("#ap-clone-text") as HTMLElement).textContent).toContain("40%");

    overlay.remove();
    expect(unsubscribed).toBe(1);
    expect(document.querySelector("#ap-clone-text")).toBeNull();
  });
});

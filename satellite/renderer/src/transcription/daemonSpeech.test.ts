// @vitest-environment jsdom
// The daemon-speech glue: resolving which daemon serves dictation (the
// primary host — the machine running the agent CLIs) and probing provider
// availability without letting a dead daemon break the settings screen.

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiForHost = vi.fn();
vi.mock("../api-for-host", () => ({ apiForHost: (h: string) => apiForHost(h) }));

const loadSettings = vi.fn();
vi.mock("../config", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../config")>();
  return { ...orig, loadSettings: () => loadSettings() };
});

import { daemonSpeechApiFor, probeDaemonSpeechProviders } from "./daemonSpeech";

describe("daemonSpeechApiFor", () => {
  beforeEach(() => {
    apiForHost.mockReset();
    loadSettings.mockReset();
  });

  it("targets the station daemon when the station is enabled", () => {
    daemonSpeechApiFor({ station: { enabled: true, url: "http://s:7315" } } as never);
    expect(apiForHost).toHaveBeenCalledWith("station");
  });

  it("targets the local daemon otherwise, including with no settings at all", () => {
    daemonSpeechApiFor(null);
    expect(apiForHost).toHaveBeenCalledWith("local");
  });
});

describe("probeDaemonSpeechProviders", () => {
  beforeEach(() => {
    apiForHost.mockReset();
    loadSettings.mockReset();
  });

  it("returns the provider statuses from the primary daemon", async () => {
    loadSettings.mockResolvedValue(null);
    apiForHost.mockReturnValue({
      dictationProviders: async () => ({
        providers: [{ provider: "claude", available: true, uses_subscription: true }],
      }),
    });
    const out = await probeDaemonSpeechProviders();
    expect(out).toEqual([{ provider: "claude", available: true, uses_subscription: true }]);
  });

  it("returns null when the daemon is unreachable or the registry is not up", async () => {
    loadSettings.mockResolvedValue(null);
    apiForHost.mockImplementation(() => {
      throw new Error("registry not initialised");
    });
    expect(await probeDaemonSpeechProviders()).toBeNull();

    apiForHost.mockReturnValue({
      dictationProviders: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await probeDaemonSpeechProviders()).toBeNull();
  });
});

// Glue between dictation and the per-host daemon plumbing. Daemon-backed
// speech (the "claude" / "codex" engines) always talks to the PRIMARY host's
// daemon: that is the machine running the agent CLIs, and therefore the one
// holding the subscription credentials the providers ride on (see daemon
// docs/concepts/dictation.md).

import type { DictationProviderStatus } from "@proto/proto";
import { apiForHost } from "../api-for-host";
import { loadSettings, primaryHost, type Settings } from "../config";
import type { DaemonDictationApi } from "./providers/DaemonDictationProvider";

/**
 * The primary host's ApiClient, narrowed to the dictation surface. Throws
 * if the per-host registry has not been initialised yet (pre-boot screens);
 * callers that can render without a daemon should catch and degrade.
 */
export function daemonSpeechApiFor(settings: Settings | null | undefined): DaemonDictationApi {
  const host = settings ? primaryHost(settings) : "local";
  return apiForHost(host);
}

/**
 * Which daemon speech providers are usable right now, or null when the
 * answer is unknowable (daemon unreachable, registry not initialised).
 * Null means "don't block the user on it" — a wrong pick still fails with
 * an actionable message at dictation time.
 */
export async function probeDaemonSpeechProviders(): Promise<DictationProviderStatus[] | null> {
  try {
    const settings = await loadSettings();
    const res = await daemonSpeechApiFor(settings).dictationProviders();
    return res.providers;
  } catch {
    return null;
  }
}

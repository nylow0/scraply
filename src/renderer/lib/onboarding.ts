const GUIDE_SEEN_KEY = "scraply:guide-seen";

export function hasSeenGuide(): boolean {
  try {
    return localStorage.getItem(GUIDE_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markGuideSeen(): void {
  try {
    localStorage.setItem(GUIDE_SEEN_KEY, "1");
  } catch {
    // ignore storage failures in restricted contexts
  }
}

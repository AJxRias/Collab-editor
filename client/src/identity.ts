const COLORS = ["#e11d48", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#c026d3"];
const ADJECTIVES = ["Quick", "Calm", "Bright", "Bold", "Keen", "Swift", "Quiet", "Lucky"];
const ANIMALS = ["Otter", "Falcon", "Panda", "Lynx", "Heron", "Fox", "Koala", "Gecko"];

export interface Identity {
  name: string;
  color: string;
}

const KEY = "collab-editor:identity";

/** A stable random identity per browser, so collaborators are distinguishable without a login. */
export function getIdentity(): Identity {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return JSON.parse(saved) as Identity;
  } catch {
    // fall through to generate a new one
  }
  const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]!;
  const identity: Identity = { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(COLORS) };
  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    // storage unavailable (private mode); identity just won't persist
  }
  return identity;
}

export function saveIdentityName(name: string): Identity {
  const identity = { ...getIdentity(), name: name.trim() || getIdentity().name };
  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    // ignore
  }
  return identity;
}

// localStorage can be missing or throw (private windows, blocked cookies), so
// every access is wrapped and the game still works without it.

const PREFIX = 'songless.';

export function load(name, fallback) {
  try {
    const raw = window.localStorage.getItem(PREFIX + name);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(name, value) {
  try {
    window.localStorage.setItem(PREFIX + name, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(name) {
  try {
    window.localStorage.removeItem(PREFIX + name);
  } catch {
    // ignore
  }
}

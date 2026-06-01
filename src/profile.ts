// Single-profile mutex. The persistent `.pball-profile` Chromium can be driven by exactly one
// process at a time — booking OR a login window — so both go through this lock. Acquiring for
// one purpose blocks the other (a login window open => booking is busy, and vice versa).
let holder: 'booking' | 'login' | null = null;

export const profileLock = {
  held: () => holder !== null,
  who: () => holder,
  acquire(w: 'booking' | 'login') {
    if (holder) return false;
    holder = w;
    return true;
  },
  release(w: 'booking' | 'login') {
    if (holder === w) holder = null;
  },
};

const officialClosures: Readonly<Record<string, readonly string[]>> = {
  // CNBV, DOF 2025-12-10, article 1: https://sidof.segob.gob.mx/notas/5775684
  '2026': ['01-01', '02-02', '03-16', '04-02', '04-03', '05-01', '09-16', '11-02', '11-16', '12-12', '12-25'],
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const moveDay = (day: string, delta: number) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return isoDay(date);
};
const monday = (year: number, month: number, occurrence: number) => {
  const first = new Date(Date.UTC(year, month - 1, 1));
  return 1 + (8 - first.getUTCDay()) % 7 + 7 * (occurrence - 1);
};
const two = (value: number) => String(value).padStart(2, '0');

// Gregorian computus (Meeus/Jones/Butcher). The annual publication remains authoritative.
const easterSunday = (year: number): string => {
  const golden = year % 19;
  const century = Math.floor(year / 100);
  const yearOfCentury = year % 100;
  const leapCenturies = Math.floor(century / 4);
  const correction = Math.floor((century - Math.floor((century + 8) / 25) + 1) / 3);
  const moon = (19 * golden + century - leapCenturies - correction + 15) % 30;
  const weekday = (32 + 2 * (century % 4) + 2 * Math.floor(yearOfCentury / 4) - moon - yearOfCentury % 4) % 7;
  const adjustment = Math.floor((golden + 11 * moon + 22 * weekday) / 451);
  const offset = moon + weekday - 7 * adjustment + 114;
  return `${String(year).padStart(4, '0')}-${two(Math.floor(offset / 31))}-${two(offset % 31 + 1)}`;
};
const provisionalClosures = (year: number) => {
  const easter = easterSunday(year);
  return ['01-01', `02-${two(monday(year, 2, 1))}`, `03-${two(monday(year, 3, 3))}`,
    moveDay(easter, -3).slice(5), moveDay(easter, -2).slice(5), '05-01', '09-16',
    '11-02', `11-${two(monday(year, 11, 3))}`, '12-12', '12-25'];
};

export const MX_BANKING_CALENDAR_VERSION = 'cnbv-2026-dof-5775684-v1';
export const mxBusinessDayOnOrBefore = (anchor: string) => {
  let date = anchor;
  let provisional = false;
  for (;;) {
    const year = date.slice(0, 4);
    const official = officialClosures[year];
    if (!official) provisional = true;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !(official ?? provisionalClosures(Number(year))).includes(date.slice(5))) {
      return { paymentDate: date, calendarStatus: provisional ? 'cnbv_calendar_provisional' as const : 'cnbv_calendar_published' as const };
    }
    date = moveDay(date, -1);
  }
};

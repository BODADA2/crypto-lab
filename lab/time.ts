// Utilitaires de temps déterministes, sensibles au fuseau horaire (ICU natif de Node, aucune dépendance).

export interface ZonedParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Vrai si le fuseau est reconnu par ICU. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Décompose un instant dans un fuseau donné. Lève si le fuseau est invalide. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : NaN;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24, // certaines versions d'ICU renvoient "24" à minuit
    minute: get("minute"),
    second: get("second"),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Clé de jour AAAA-MM-JJ dans le fuseau. */
export function dateKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Clé de semaine ISO 8601 (AAAA-Www) dans le fuseau. */
export function isoWeekKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const weekday = d.getUTCDay() || 7; // lundi=1 .. dimanche=7
  d.setUTCDate(d.getUTCDate() + 4 - weekday); // jeudi de la même semaine ISO
  const isoYear = d.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${pad2(week)}`;
}

/** Heure locale (0..23) dans le fuseau. */
export function hourInZone(date: Date, timeZone: string): number {
  return zonedParts(date, timeZone).hour;
}

/** ISO 8601 strict : date, heure, et fuseau OBLIGATOIRE (Z ou ±HH:MM). Les dates sans fuseau dépendraient de la machine. */
const ISO_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Parse une date ISO stricte (fuseau obligatoire) ; renvoie null si invalide. Jamais d'exception. */
export function parseIso(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_STRICT.test(value)) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

/** Normalise une valeur "now" (Date, ISO, epoch ms) en Date valide, sinon null. */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  return parseIso(value);
}

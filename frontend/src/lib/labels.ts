/** Turns raw column names into names anyone can read: HS_GPA -> "High school GPA". */
const KNOWN: [RegExp, string][] = [
  [/^(hs_?)?gpa$|high.?school.?gpa|hs_gpa/i, "High school GPA"],
  [/transfer.?gpa/i, "Transfer GPA"],
  [/test.?score|sat|act/i, "ACT/SAT score"],
  [/class.?rank/i, "Class rank percentile"],
  [/aid.?offer|aid_amt|aid$|financial.?aid/i, "Financial aid offer"],
  [/scholar/i, "Scholarship amount"],
  [/fafsa/i, "FAFSA received"],
  [/efc|\bsai\b/i, "Expected family contribution"],
  [/campus.?visit|visit/i, "Visit attendance"],
  [/housing/i, "Housing interest"],
  [/email/i, "Email engagement"],
  [/event/i, "Events attended"],
  [/orientation|rsvp/i, "Orientation sign-up"],
  [/first.?gen/i, "First-generation student"],
  [/distance|miles/i, "Distance from campus"],
  [/resid/i, "Residency (in-state / out-of-state)"],
  [/^major$|intended.?major|major/i, "Major interest"],
  [/college/i, "College"],
  [/days.?to.?admit|admit.?speed/i, "Days to admission"],
  [/app.?round|round/i, "Application round"],
  [/app.?date/i, "Application date"],
  [/decision.?plan/i, "Admissions decision plan"],
  [/source/i, "Application source"],
  [/race|ipeds|ethnic/i, "Race / ethnicity"],
  [/gender|sex/i, "Gender"],
  [/wl|waitlist/i, "Admitted from waitlist"],
  [/credit/i, "Credits transferred"],
];

export function friendly(col: string) {
  const hit = KNOWN.find(([re]) => re.test(col));
  if (hit) return hit[1];
  const words = col
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Display names for the fields the backend maps (keys match backend/app/services/fields.py). */
export const FIELDS: { key: import("./api").FieldKey; label: string; required: boolean }[] = [
  { key: "studentId", label: "Student ID", required: true },
  { key: "term", label: "Term", required: true },
  { key: "outcome", label: "Enrollment outcome", required: true },
  { key: "admitStatus", label: "Admit status", required: false },
  { key: "studentType", label: "Student type", required: false },
  { key: "college", label: "College", required: false },
  { key: "major", label: "Major", required: false },
  { key: "residency", label: "Residency", required: false },
  { key: "gpa", label: "GPA", required: false },
  { key: "aid", label: "Financial aid offer", required: false },
  { key: "housing", label: "Housing interest", required: false },
];

const PS_SEASON: Record<string, string> = { "2": "Spring", "4": "Fall", "6": "Summer", "8": "Summer" };

/** "2264" → "Fall 2026". Mirrors backend/app/engine/terms.py so both sides name terms the same. */
export function termName(code?: string | null): string {
  const c = String(code ?? "").trim();
  let m = /^2(\d)(\d)(\d)$/.exec(c);
  if (m && PS_SEASON[m[3]]) return `${PS_SEASON[m[3]]} ${2000 + 10 * +m[1] + +m[2]}`;
  m = /(spring|summer|fall|autumn|winter)\D*((?:19|20)\d\d)|((?:19|20)\d\d)\D*(spring|summer|fall|autumn|winter)/i.exec(c);
  if (m) {
    const s = (m[1] || m[4]).toLowerCase().replace("autumn", "fall");
    return `${s[0].toUpperCase()}${s.slice(1)} ${m[2] || m[3]}`;
  }
  return c;
}
export const termList = (codes: string[] = []) => codes.map(termName).join(", ");

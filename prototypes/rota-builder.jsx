import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  ChevronLeft, ChevronRight, Plus, X, Check, Wand2, Lock, Unlock, Shuffle,
  AlertTriangle, Users, CalendarRange, Sliders, Printer, RotateCcw, Moon, Info
} from "lucide-react";

/* ==========================================================================
   Rota Builder — availability in, rota out.
   Sumy sets who can work when and how many bodies each shift needs.
   The app fills it, shows what it couldn't fill and why, and lets her
   override any cell and rebuild around the bits she's locked.
   ========================================================================== */

const T = {
  paper: "#F1F3F1", surface: "#FFFFFF", ink: "#16211E", body: "#3B4A46",
  muted: "#6E7A76", rule: "#DCE0DC", ruleSoft: "#EAEDE9",
  accent: "#1F6F5C", accentBg: "#DEEBE5",
  night: "#2C3A63", nightBg: "#E1E5EF",
  alert: "#A8341F", alertBg: "#F6E3DE",
  warn: "#B07D14", warnBg: "#F7EDD6",
  leave: "#8A5A2B", leaveBg: "#F2E8DC",
};
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const ROLES = ["Manager", "Deputy", "SCO", "CO", "BCO", "WCO", "Kitchen", "Dom"];
const ROLE_RANK = Object.fromEntries(ROLES.map((r, i) => [r, i]));

/* ---------- shift catalogue (tenant config in the real build) ---------- */
const DEFAULT_SHIFTS = [
  { key: "early", name: "Early",  start: "07:00", end: "15:00" },
  { key: "mid",   name: "Mid",    start: "13:00", end: "21:00" },
  { key: "back",  name: "Back",   start: "15:00", end: "23:00" },
  { key: "night", name: "Night",  start: "21:00", end: "07:00" },
];

const LEAVE_CODES = { "AL": "Annual leave", "SL": "Sick", "TR": "Training" };

/* ---------- helpers ---------- */
const mondayOf = (d) => { const x = new Date(d); x.setHours(12,0,0,0); x.setDate(x.getDate() - ((x.getDay()+6)%7)); return x; };
const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const weekKey = (d) => { const m = mondayOf(d); return `${m.getFullYear()}-${String(m.getMonth()+1).padStart(2,"0")}-${String(m.getDate()).padStart(2,"0")}`; };
const ddmm = (d) => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}`;
const toMin = (t) => { const [h,m] = t.split(":").map(Number); return h*60+m; };
const shiftHours = (s) => { let l = toMin(s.end)-toMin(s.start); if (l<=0) l+=1440; return l/60; };
const shortTime = (t) => (t.endsWith(":00") ? t.slice(0,2) : t);
const label = (s) => `${shortTime(s.start)}–${shortTime(s.end)}`;
// absolute hour-of-week for start / end
const absStart = (day, s) => day*24 + toMin(s.start)/60;
const absEnd = (day, s) => absStart(day, s) + shiftHours(s);

const mulberry = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/* ---------- seed ---------- */
const SEED_STAFF = [
  ["Sumy","Manager",37.5,true],["Tracey","Deputy",37.5,false],["Eliza","SCO",37.5,false],
  ["Roma","CO",24,false],["Ayo","CO",37.5,false],["Olu","CO",37.5,false],["Janet","CO",30,false],
  ["Vincent","CO",18,false],["Kaushik","CO",16,false],["Victoria","CO",20,false],
  ["Raghul","BCO",30,false],["Ola","BCO",10,false],["Divin","BCO",24,false],
  ["Esther","WCO",30,false],["Brian K","Kitchen",24,false],["Gail","Dom",20,false],
].map(([name, role, contractHours, officeHours], i) => ({
  id: `s${i+1}`, name, role, contractHours, officeHours, maxDays: 5, active: true,
}));

// availability: mode 'any' | 'shifts' | 'off'
const seedAvailability = () => {
  const av = {};
  SEED_STAFF.forEach((s) => {
    for (let d = 0; d < 7; d++) {
      let mode = "any", shifts = [];
      if (s.role === "WCO") { mode = "shifts"; shifts = ["night"]; }
      if (s.role === "Deputy") { mode = d < 5 ? "shifts" : "off"; shifts = ["early"]; }
      if (s.name === "Vincent" || s.name === "Kaushik") mode = d === 0 || d >= 5 ? "any" : "off";
      if (s.name === "Ola" && d !== 1) mode = "off";
      av[`${s.id}|${d}`] = { mode, shifts };
    }
  });
  return av;
};

const seedDemand = () => {
  const d = {};
  for (let i = 0; i < 7; i++) d[i] = { early: 3, mid: 1, back: 3, night: 1, sleepovers: 1 };
  return d;
};

const buildSeed = () => ({
  homeName: "Linkfield Residential Ltd",
  shifts: DEFAULT_SHIFTS,
  staff: SEED_STAFF,
  availability: seedAvailability(),
  demand: seedDemand(),
  weeks: {},
});

/* ==========================================================================
   THE GENERATOR
   Hard rules are never broken — if a slot can't be filled legally it is
   left open and reported. Soft rules are scored.
   ========================================================================== */
function generateRota({ staff, shifts, availability, demand, locked, seed }) {
  const rnd = mulberry(seed);
  const shiftBy = Object.fromEntries(shifts.map((s) => [s.key, s]));
  const assignments = { ...locked };
  const unfilled = [];

  // running state per staff
  const state = {};
  staff.forEach((s) => { state[s.id] = { hours: 0, days: 0, weekend: 0, intervals: [], byDay: {} }; });

  const noteExisting = (staffId, day, a) => {
    const st = state[staffId];
    if (!st || a.kind !== "shift") return;
    const sh = shiftBy[a.shiftKey] || { start: a.start, end: a.end };
    st.hours += shiftHours(sh);
    st.days += 1;
    if (day >= 5) st.weekend += 1;
    st.byDay[day] = a.shiftKey;
    st.intervals.push([absStart(day, sh), absEnd(day, sh) + (a.sleepover ? 8 : 0)]);
  };
  Object.entries(locked).forEach(([k, a]) => {
    const [staffId, day] = k.split("|");
    noteExisting(staffId, Number(day), a);
  });

  const isLocked = (staffId, day) => Boolean(locked[`${staffId}|${day}`]);

  // ---- hard rules ----
  function reject(s, day, sh) {
    const st = state[s.id];
    if (isLocked(s.id, day) || st.byDay[day] !== undefined) return "already on that day";
    const av = availability[`${s.id}|${day}`] || { mode: "any", shifts: [] };
    if (av.mode === "off") return "not available";
    if (av.mode === "shifts" && !av.shifts.includes(sh.key)) return "does not work this shift";
    if (st.days + 1 > (s.maxDays || 7)) return "at their maximum days";
    const len = shiftHours(sh);
    const cap = Math.min(48, (s.contractHours || 37.5) * 1.25);
    if (st.hours + len > cap) return "would go over their hours";
    const start = absStart(day, sh), end = absEnd(day, sh);
    for (const [a, b] of st.intervals) {
      if (start < b + 11 && a - 11 < end) {
        return start < b && end > a ? "overlaps another shift" : "under 11 hours rest";
      }
    }
    return null;
  }

  // ---- soft scoring: lower is better ----
  function score(s, day, sh) {
    const st = state[s.id];
    const av = availability[`${s.id}|${day}`] || { mode: "any", shifts: [] };
    let sc = 0;
    const contract = s.contractHours || 37.5;
    sc -= (contract - st.hours) * 2.2;                       // who most needs hours
    if (av.mode === "shifts" && av.shifts.includes(sh.key)) sc -= 6;   // asked for this shift
    if (sh.key === "night" && s.role === "WCO") sc -= 8;
    if (sh.key === "night" && (s.role === "Manager" || s.role === "Deputy")) sc += 14;
    if (st.byDay[day - 1] === sh.key) sc -= 4;               // keep blocks together
    if (day >= 5) sc += st.weekend * 3;                      // spread weekends
    if (s.role === "BCO") sc += 4;                           // use bank staff last
    sc += rnd() * 2.5;
    return sc;
  }

  // ---- build slot list, hardest first ----
  const slots = [];
  for (let day = 0; day < 7; day++) {
    shifts.forEach((sh) => {
      const need = demand[day]?.[sh.key] || 0;
      const already = Object.entries(locked).filter(([k, a]) => {
        const [, d] = k.split("|");
        return Number(d) === day && a.kind === "shift" && a.shiftKey === sh.key;
      }).length;
      for (let i = 0; i < need - already; i++) slots.push({ day, sh });
    });
  }
  const pool = (day, sh) => staff.filter((s) => s.active && !s.officeHours && !reject(s, day, sh)).length;
  slots.sort((a, b) => {
    const scarcity = pool(a.day, a.sh) - pool(b.day, b.sh);
    if (scarcity !== 0) return scarcity;
    return (a.sh.key === "night" ? 0 : 1) - (b.sh.key === "night" ? 0 : 1);
  });

  // ---- fill ----
  slots.forEach(({ day, sh }) => {
    const reasons = {};
    const candidates = [];
    staff.forEach((s) => {
      if (!s.active || s.officeHours) return;
      const why = reject(s, day, sh);
      if (why) { reasons[why] = (reasons[why] || 0) + 1; return; }
      candidates.push({ s, sc: score(s, day, sh) });
    });
    if (!candidates.length) {
      unfilled.push({ day, shift: sh, reasons });
      return;
    }
    candidates.sort((a, b) => a.sc - b.sc);
    const pick = candidates[0].s;
    assignments[`${pick.id}|${day}`] = { kind: "shift", shiftKey: sh.key, sleepover: false };
    noteExisting(pick.id, day, assignments[`${pick.id}|${day}`]);
  });

  // ---- sleepovers: someone already on a late shift stays over ----
  for (let day = 0; day < 7; day++) {
    let need = demand[day]?.sleepovers || 0;
    const have = staff.filter((s) => assignments[`${s.id}|${day}`]?.sleepover).length;
    need -= have;
    if (need <= 0) continue;
    const eligible = staff.filter((s) => {
      if (isLocked(s.id, day)) return false;
      const a = assignments[`${s.id}|${day}`];
      if (a?.kind !== "shift" || a.sleepover) return false;
      const sh = shiftBy[a.shiftKey];
      if (!sh || toMin(sh.end) < 20 * 60 || sh.key === "night") return false;
      const next = assignments[`${s.id}|${day + 1}`];
      if (next?.kind === "shift") {
        const ns = shiftBy[next.shiftKey];
        if (ns && absStart(day + 1, ns) < absEnd(day, sh) + 8 + 11) return false;
      }
      return true;
    });
    eligible.slice(0, need).forEach((s) => { assignments[`${s.id}|${day}`].sleepover = true; });
    if (eligible.length < need) unfilled.push({ day, shift: { name: "Sleepover", key: "sleepover" }, reasons: { "nobody on a late shift is free to stay": 1 } });
  }

  // ---- office-hours staff and days off ----
  staff.forEach((s) => {
    for (let day = 0; day < 7; day++) {
      const k = `${s.id}|${day}`;
      if (assignments[k]) continue;
      const av = availability[k] || { mode: "any" };
      if (s.officeHours && day < 5 && av.mode !== "off") { assignments[k] = { kind: "code", code: "IN" }; continue; }
      assignments[k] = { kind: "code", code: "D/O" };
    }
  });

  return { assignments, unfilled };
}

/* ========================================================================== */

export default function RotaBuilder() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("rota");
  const [anchor, setAnchor] = useState(() => new Date(2026, 7, 17));
  const [seed, setSeed] = useState(1);
  const [editing, setEditing] = useState(null);
  const [staffPanel, setStaffPanel] = useState(false);
  const [toast, setToast] = useState("");

  const wk = weekKey(anchor);
  const monday = mondayOf(anchor);
  const dates = useMemo(() => DAYS.map((_, i) => addDays(monday, i)), [monday.getTime()]);

  useEffect(() => {
    (async () => {
      try { setData(JSON.parse((await window.storage.get("rotabuilder:v1")).value)); }
      catch { const s = buildSeed(); setData(s); try { await window.storage.set("rotabuilder:v1", JSON.stringify(s)); } catch {} }
    })();
  }, []);

  const persist = useCallback(async (next) => {
    setData(next);
    try { await window.storage.set("rotabuilder:v1", JSON.stringify(next)); }
    catch { flash("Not saved — storage unavailable"); }
  }, []);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 3500); };

  const week = data?.weeks?.[wk] || { assignments: {}, locked: {}, unfilled: [], onCall: null, built: false };
  const setWeek = (patch) => persist({ ...data, weeks: { ...data.weeks, [wk]: { ...week, ...patch } } });

  const staff = useMemo(() =>
    (data?.staff || []).filter((s) => s.active).slice()
      .sort((a, b) => (ROLE_RANK[a.role] ?? 99) - (ROLE_RANK[b.role] ?? 99) || a.name.localeCompare(b.name)),
    [data]);

  const shiftBy = useMemo(() => Object.fromEntries((data?.shifts || []).map((s) => [s.key, s])), [data]);

  const build = (newSeed) => {
    const s = newSeed ?? seed;
    setSeed(s);
    const { assignments, unfilled } = generateRota({
      staff, shifts: data.shifts, availability: data.availability,
      demand: data.demand, locked: week.locked || {}, seed: s,
    });
    setWeek({ assignments, unfilled, built: true });
    flash(unfilled.length ? `Rota built — ${unfilled.length} slot${unfilled.length > 1 ? "s" : ""} still open` : "Rota built — everything covered");
  };

  const totals = useMemo(() => {
    const out = {};
    staff.forEach((s) => {
      let hours = 0, days = 0, so = 0;
      for (let d = 0; d < 7; d++) {
        const a = week.assignments[`${s.id}|${d}`];
        if (a?.kind !== "shift") continue;
        const sh = shiftBy[a.shiftKey]; if (!sh) continue;
        hours += shiftHours(sh); days += 1; if (a.sleepover) so += 1;
      }
      out[s.id] = { hours, days, so };
    });
    return out;
  }, [staff, week, shiftBy]);

  if (!data) return <Splash />;

  return (
    <div style={{ minHeight: "100vh", background: T.paper, fontFamily: SANS, color: T.ink }}>
      <style>{`
        @media print { .no-print{display:none!important} body{background:#fff!important} }
        .cellbtn:hover{background:${T.ruleSoft}!important}
        .cellbtn:focus-visible{outline:2px solid ${T.accent};outline-offset:-2px}
        @media (prefers-reduced-motion: reduce){*{transition:none!important}}
      `}</style>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "18px 12px 70px" }}>
        <header className="no-print">
          <div style={{ fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", color: T.muted, fontWeight: 600 }}>
            Rota builder
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 650, letterSpacing: "-.02em", margin: "2px 0 14px" }}>{data.homeName}</h1>

          <div style={{ display: "flex", gap: 4, marginBottom: 14, borderBottom: `1px solid ${T.rule}` }}>
            {[["rota", "Rota", CalendarRange], ["availability", "Who can work when", Users], ["cover", "Cover needed", Sliders]]
              .map(([k, lbl, Icon]) => (
                <button key={k} onClick={() => setTab(k)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 13px", fontSize: 13.5,
                    fontFamily: SANS, cursor: "pointer", border: "none", background: "transparent",
                    color: tab === k ? T.accent : T.muted, fontWeight: tab === k ? 600 : 500,
                    borderBottom: `2px solid ${tab === k ? T.accent : "transparent"}`, marginBottom: -1,
                  }}>
                  <Icon size={14} />{lbl}
                </button>
              ))}
          </div>
        </header>

        {toast && (
          <div className="no-print" style={{ background: T.accentBg, color: T.accent, padding: "9px 12px",
                  borderRadius: 7, fontSize: 13, marginBottom: 12, display: "flex", gap: 7, alignItems: "center" }}>
            <Info size={14} />{toast}
          </div>
        )}

        {tab === "rota" && (
          <RotaTab
            data={data} staff={staff} shiftBy={shiftBy} week={week} setWeek={setWeek}
            dates={dates} monday={monday} setAnchor={setAnchor} totals={totals}
            build={build} setSeed={setSeed} seed={seed}
            onEdit={setEditing} openStaff={() => setStaffPanel(true)}
          />
        )}
        {tab === "availability" && <AvailabilityTab data={data} staff={staff} persist={persist} openStaff={() => setStaffPanel(true)} />}
        {tab === "cover" && <CoverTab data={data} persist={persist} />}
      </div>

      {editing && (
        <CellEditor
          staff={data.staff.find((s) => s.id === editing.staffId)}
          day={editing.day} date={dates[editing.day]} shifts={data.shifts}
          value={week.assignments[`${editing.staffId}|${editing.day}`]}
          locked={Boolean(week.locked?.[`${editing.staffId}|${editing.day}`])}
          onSave={(v, lock) => {
            const key = `${editing.staffId}|${editing.day}`;
            const a = { ...week.assignments }, l = { ...(week.locked || {}) };
            if (v === null) delete a[key]; else a[key] = v;
            if (lock && v) l[key] = v; else delete l[key];
            setWeek({ assignments: a, locked: l });
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {staffPanel && <StaffPanel data={data} persist={persist} onClose={() => setStaffPanel(false)} />}
    </div>
  );
}

/* ---------------------------- ROTA TAB ---------------------------- */
function RotaTab({ data, staff, shiftBy, week, setWeek, dates, monday, setAnchor, totals, build, seed, setSeed, onEdit, openStaff }) {
  const lockedCount = Object.keys(week.locked || {}).length;

  return (
    <>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <IconBtn onClick={() => setAnchor(addDays(monday, -7))} label="Previous week"><ChevronLeft size={17} /></IconBtn>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600 }}>{ddmm(dates[0])} – {ddmm(dates[6])}</div>
          <div style={{ fontSize: 10, letterSpacing: ".16em", color: T.muted, textTransform: "uppercase", marginTop: 1 }}>
            {monday.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
          </div>
        </div>
        <IconBtn onClick={() => setAnchor(addDays(monday, 7))} label="Next week"><ChevronRight size={17} /></IconBtn>
      </div>

      <div className="no-print" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        <button onClick={() => build(seed)}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 16px", borderRadius: 8,
                   border: "none", background: T.accent, color: "#fff", fontSize: 14, fontWeight: 600,
                   fontFamily: SANS, cursor: "pointer" }}>
          <Wand2 size={15} />{week.built ? "Build again" : "Build the rota"}
        </button>
        {week.built && <Btn onClick={() => build(Math.floor(Math.random() * 99999))} icon={Shuffle}>Try a different one</Btn>}
        <Btn onClick={openStaff} icon={Users}>Staff</Btn>
        <Btn onClick={() => window.print()} icon={Printer}>Print</Btn>
        {lockedCount > 0 && (
          <Btn onClick={() => setWeek({ locked: {} })} icon={RotateCcw}>Unlock all ({lockedCount})</Btn>
        )}
      </div>

      {!week.built && (
        <div style={{ background: T.surface, border: `1px dashed ${T.rule}`, borderRadius: 10,
                      padding: "34px 22px", textAlign: "center", marginBottom: 16 }}>
          <Wand2 size={26} color={T.accent} />
          <div style={{ fontSize: 15.5, fontWeight: 600, marginTop: 10 }}>No rota for this week yet</div>
          <p style={{ fontSize: 13, color: T.muted, maxWidth: 400, margin: "6px auto 0", lineHeight: 1.55 }}>
            Check availability and cover on the other two tabs, then build. Anything you change
            afterwards can be locked so the next build works around it.
          </p>
        </div>
      )}

      {week.built && (
        <>
          {week.unfilled?.length > 0 && (
            <div style={{ marginBottom: 14, border: `1px solid ${T.alertBg}`, borderRadius: 10, overflow: "hidden" }}>
              <div style={{ background: T.alertBg, color: T.alert, padding: "9px 13px", fontSize: 12.5,
                            fontWeight: 600, display: "flex", gap: 7, alignItems: "center" }}>
                <AlertTriangle size={14} />{week.unfilled.length} slot{week.unfilled.length > 1 ? "s" : ""} could not be filled
              </div>
              <div style={{ background: T.surface }}>
                {week.unfilled.map((u, i) => (
                  <div key={i} style={{ padding: "10px 13px", borderTop: i ? `1px solid ${T.ruleSoft}` : "none", fontSize: 13 }}>
                    <strong style={{ fontWeight: 600 }}>{SHORT[u.day]} · {u.shift.name}</strong>
                    <div style={{ color: T.muted, fontSize: 12, marginTop: 3, lineHeight: 1.5 }}>
                      {Object.entries(u.reasons).map(([r, n]) => `${n} ${r}`).join(" · ") || "nobody available"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ background: T.surface, border: `1px solid ${T.rule}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 880 }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: "left", position: "sticky", left: 0, background: T.surface, zIndex: 2, minWidth: 148 }}>STAFF</th>
                    {DAYS.map((d, i) => (
                      <th key={d} style={{ ...th, minWidth: 98 }}>
                        <div style={{ fontSize: 10, letterSpacing: ".14em" }}>{SHORT[i].toUpperCase()}</div>
                        <div style={{ fontFamily: MONO, fontSize: 11.5, color: T.muted, fontWeight: 500 }}>{ddmm(dates[i])}</div>
                      </th>
                    ))}
                    <th style={{ ...th, minWidth: 74 }}>HOURS</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((s, idx) => {
                    const bg = idx % 2 ? "#FCFDFC" : T.surface;
                    const t = totals[s.id];
                    const short = t.hours < (s.contractHours || 0) - 0.5;
                    return (
                      <tr key={s.id} style={{ background: bg }}>
                        <td style={{ ...td, position: "sticky", left: 0, background: bg, zIndex: 1, borderRight: `1px solid ${T.rule}` }}>
                          <div style={{ fontSize: 14, fontWeight: 560 }}>{s.name}</div>
                          <div style={{ fontSize: 10, letterSpacing: ".1em", color: T.muted, textTransform: "uppercase" }}>{s.role}</div>
                        </td>
                        {DAYS.map((_, d) => (
                          <td key={d} style={{ ...td, padding: 0 }}>
                            <Cell a={week.assignments[`${s.id}|${d}`]} shiftBy={shiftBy}
                                  locked={Boolean(week.locked?.[`${s.id}|${d}`])}
                                  onClick={() => onEdit({ staffId: s.id, day: d })} />
                          </td>
                        ))}
                        <td style={{ ...td, textAlign: "center", fontFamily: MONO, fontSize: 13 }}>
                          <div style={{ fontWeight: 600, color: short ? T.warn : T.ink }}>{t.hours.toFixed(1)}</div>
                          <div style={{ fontSize: 10, color: T.muted }}>of {s.contractHours}</div>
                          {t.so > 0 && <div style={{ fontSize: 10, color: T.night }}>+{t.so} S/O</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ borderTop: `1px solid ${T.rule}`, padding: "11px 15px", display: "flex",
                          alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, letterSpacing: ".16em", color: T.muted, fontWeight: 600 }}>ON CALL</span>
              <select value={week.onCall || ""} onChange={(e) => setWeek({ onCall: e.target.value || null })}
                style={{ fontFamily: SANS, fontSize: 14, padding: "5px 9px", borderRadius: 6,
                         border: `1px solid ${T.rule}`, background: T.surface, color: T.ink }}>
                <option value="">Nobody set</option>
                {data.staff.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <span style={{ marginLeft: "auto", fontSize: 11.5, color: T.muted, display: "flex", gap: 5, alignItems: "center" }}>
                <Lock size={11} /> locked cells survive the next build
              </span>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------ AVAILABILITY TAB ------------------------ */
function AvailabilityTab({ data, staff, persist, openStaff }) {
  const set = (staffId, day, patch) => {
    const key = `${staffId}|${day}`;
    const cur = data.availability[key] || { mode: "any", shifts: [] };
    persist({ ...data, availability: { ...data.availability, [key]: { ...cur, ...patch } } });
  };
  const cycle = (staffId, day) => {
    const cur = data.availability[`${staffId}|${day}`] || { mode: "any", shifts: [] };
    const next = cur.mode === "any" ? "shifts" : cur.mode === "shifts" ? "off" : "any";
    set(staffId, day, { mode: next, shifts: next === "shifts" ? (cur.shifts.length ? cur.shifts : ["early"]) : cur.shifts });
  };
  const toggleShift = (staffId, day, key) => {
    const cur = data.availability[`${staffId}|${day}`] || { mode: "shifts", shifts: [] };
    const shifts = cur.shifts.includes(key) ? cur.shifts.filter((k) => k !== key) : [...cur.shifts, key];
    set(staffId, day, { mode: "shifts", shifts });
  };
  const applyAll = (staffId, day) => {
    const cur = data.availability[`${staffId}|${day}`];
    const av = { ...data.availability };
    for (let d = 0; d < 7; d++) av[`${staffId}|${d}`] = { ...cur };
    persist({ ...data, availability: av });
  };

  return (
    <>
      <p style={{ fontSize: 13, color: T.body, lineHeight: 1.55, marginBottom: 14, maxWidth: 620 }}>
        Tap a day to move it between <strong>available</strong>, <strong>only certain shifts</strong> and{" "}
        <strong>not available</strong>. This is the usual pattern — one-off leave goes straight on the rota.
      </p>
      <div className="no-print" style={{ marginBottom: 12 }}><Btn onClick={openStaff} icon={Users}>Staff and contracts</Btn></div>

      <div style={{ display: "grid", gap: 8 }}>
        {staff.map((s) => (
          <div key={s.id} style={{ background: T.surface, border: `1px solid ${T.rule}`, borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 9 }}>
              <span style={{ fontSize: 14.5, fontWeight: 600 }}>{s.name}</span>
              <span style={{ fontSize: 10, letterSpacing: ".1em", color: T.muted, textTransform: "uppercase" }}>{s.role}</span>
              <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 12, color: T.muted }}>
                {s.contractHours}h · max {s.maxDays} days
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5 }}>
              {DAYS.map((_, d) => {
                const av = data.availability[`${s.id}|${d}`] || { mode: "any", shifts: [] };
                const tone = av.mode === "off" ? { fg: T.muted, bg: T.paper, bd: T.rule }
                  : av.mode === "shifts" ? { fg: T.night, bg: T.nightBg, bd: T.night }
                  : { fg: T.accent, bg: T.accentBg, bd: T.accent };
                return (
                  <div key={d}>
                    <button onClick={() => cycle(s.id, d)} onDoubleClick={() => applyAll(s.id, d)}
                      title="Tap to change · double tap to copy to the whole week"
                      style={{ width: "100%", padding: "7px 2px", borderRadius: 6, cursor: "pointer",
                               border: `1px solid ${tone.bd}`, background: tone.bg, color: tone.fg,
                               fontSize: 10.5, fontWeight: 600, letterSpacing: ".06em" }}>
                      <div style={{ fontSize: 10, opacity: .75 }}>{SHORT[d].toUpperCase()}</div>
                      <div style={{ marginTop: 2 }}>
                        {av.mode === "off" ? "OFF" : av.mode === "any" ? "ANY" : "SOME"}
                      </div>
                    </button>
                    {av.mode === "shifts" && (
                      <div style={{ display: "grid", gap: 2, marginTop: 3 }}>
                        {data.shifts.map((sh) => {
                          const on = av.shifts.includes(sh.key);
                          return (
                            <button key={sh.key} onClick={() => toggleShift(s.id, d, sh.key)}
                              style={{ fontFamily: MONO, fontSize: 9, padding: "3px 1px", borderRadius: 4, cursor: "pointer",
                                       border: `1px solid ${on ? T.night : T.ruleSoft}`,
                                       background: on ? T.night : T.surface, color: on ? "#fff" : T.muted }}>
                              {shortTime(sh.start)}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* --------------------------- COVER TAB --------------------------- */
function CoverTab({ data, persist }) {
  const set = (day, key, val) =>
    persist({ ...data, demand: { ...data.demand, [day]: { ...data.demand[day], [key]: Math.max(0, val) } } });
  const copyToAll = (day) => {
    const d = { ...data.demand };
    for (let i = 0; i < 7; i++) d[i] = { ...data.demand[day] };
    persist({ ...data, demand: d });
  };
  const rows = [...data.shifts.map((s) => ({ key: s.key, name: s.name, sub: label(s) })),
                { key: "sleepovers", name: "Sleepover", sub: "stays until 07:00" }];

  return (
    <>
      <p style={{ fontSize: 13, color: T.body, lineHeight: 1.55, marginBottom: 14, maxWidth: 620 }}>
        How many people you need on each shift. The builder will not go below these numbers —
        if it cannot reach them it leaves the slot open and tells you why.
      </p>
      <div style={{ background: T.surface, border: `1px solid ${T.rule}`, borderRadius: 10, overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", minWidth: 140 }}>SHIFT</th>
              {DAYS.map((d, i) => <th key={d} style={{ ...th, minWidth: 64 }}>{SHORT[i].toUpperCase()}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td style={{ ...td, borderRight: `1px solid ${T.rule}` }}>
                  <div style={{ fontSize: 14, fontWeight: 560 }}>{r.name}</div>
                  <div style={{ fontFamily: MONO, fontSize: 11, color: T.muted }}>{r.sub}</div>
                </td>
                {DAYS.map((_, d) => (
                  <td key={d} style={{ ...td, textAlign: "center" }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <Step onClick={() => set(d, r.key, (data.demand[d]?.[r.key] || 0) - 1)}>−</Step>
                      <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, width: 16 }}>
                        {data.demand[d]?.[r.key] ?? 0}
                      </span>
                      <Step onClick={() => set(d, r.key, (data.demand[d]?.[r.key] || 0) + 1)}>+</Step>
                    </div>
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td style={{ ...td, borderRight: `1px solid ${T.rule}`, fontSize: 12, color: T.muted }}>Copy a day across</td>
              {DAYS.map((_, d) => (
                <td key={d} style={{ ...td, textAlign: "center" }}>
                  <button onClick={() => copyToAll(d)}
                    style={{ fontSize: 11, padding: "4px 8px", borderRadius: 5, cursor: "pointer",
                             border: `1px solid ${T.rule}`, background: T.surface, color: T.body }}>copy</button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------------------------- bits ---------------------------- */
const th = { padding: "9px 7px", textAlign: "center", borderBottom: `1.5px solid ${T.rule}`,
             fontWeight: 600, color: T.body, textTransform: "uppercase", fontSize: 10, letterSpacing: ".14em", verticalAlign: "bottom" };
const td = { padding: "7px 8px", borderBottom: `1px solid ${T.ruleSoft}`, verticalAlign: "middle" };

function Cell({ a, shiftBy, locked, onClick }) {
  let inner;
  if (!a) inner = <span style={{ color: T.rule, fontSize: 17 }}>+</span>;
  else if (a.kind === "code") {
    const isOff = a.code === "D/O";
    inner = <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600,
      color: isOff ? T.muted : a.code === "IN" ? T.accent : T.leave,
      background: isOff ? "transparent" : a.code === "IN" ? T.accentBg : T.leaveBg,
      padding: isOff ? 0 : "2px 6px", borderRadius: 4 }}>{a.code}</span>;
  } else {
    const sh = shiftBy[a.shiftKey];
    const night = sh && (toMin(sh.start) >= 1200 || toMin(sh.end) <= toMin(sh.start));
    inner = (
      <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
        <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: night ? T.night : T.ink }}>
          {sh ? label(sh) : "?"}
        </span>
        {a.sleepover && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9, fontWeight: 700,
                         color: T.night, background: T.nightBg, padding: "1px 5px", borderRadius: 3 }}>
            <Moon size={8} /> S/O
          </span>
        )}
      </span>
    );
  }
  return (
    <button className="cellbtn" onClick={onClick}
      style={{ width: "100%", minHeight: 50, border: "none", background: "transparent", cursor: "pointer",
               display: "flex", alignItems: "center", justifyContent: "center", position: "relative", padding: "6px 4px" }}>
      {inner}
      {locked && <Lock size={9} color={T.accent} style={{ position: "absolute", top: 4, right: 4 }} />}
    </button>
  );
}

function CellEditor({ staff, day, date, shifts, value, locked, onClose, onSave }) {
  const [lock, setLock] = useState(locked);
  const [sleepover, setSleepover] = useState(value?.sleepover || false);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(22,33,30,.35)", zIndex: 50,
            display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: T.surface, width: "100%", maxWidth: 500, maxHeight: "88vh", overflowY: "auto",
                 borderRadius: "14px 14px 0 0", padding: "18px 18px 26px", fontFamily: SANS }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 15 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 620 }}>{staff.name}</div>
            <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>{DAYS[day]} {ddmm(date)}</div>
          </div>
          <IconBtn onClick={onClose} label="Close"><X size={16} /></IconBtn>
        </div>

        <button onClick={() => setLock(!lock)}
          style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "10px 12px", marginBottom: 16,
                   borderRadius: 8, cursor: "pointer", textAlign: "left",
                   border: `1px solid ${lock ? T.accent : T.rule}`, background: lock ? T.accentBg : T.surface }}>
          {lock ? <Lock size={15} color={T.accent} /> : <Unlock size={15} color={T.muted} />}
          <span style={{ flex: 1, fontSize: 13.5, color: lock ? T.accent : T.body }}>
            Keep this when the rota is built again
          </span>
        </button>

        <Label>Put them on</Label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px,1fr))", gap: 6, marginBottom: 8 }}>
          {shifts.map((sh) => (
            <button key={sh.key} onClick={() => onSave({ kind: "shift", shiftKey: sh.key, sleepover }, lock)}
              style={{ padding: "9px 6px", borderRadius: 7, cursor: "pointer", textAlign: "center",
                       border: `1px solid ${value?.shiftKey === sh.key ? T.accent : T.rule}`,
                       background: value?.shiftKey === sh.key ? T.accentBg : T.surface }}>
              <div style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600 }}>{label(sh)}</div>
              <div style={{ fontSize: 10, color: T.muted, marginTop: 1 }}>{sh.name}</div>
            </button>
          ))}
        </div>

        <button onClick={() => setSleepover(!sleepover)}
          style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 12px", marginBottom: 18,
                   borderRadius: 8, cursor: "pointer", textAlign: "left",
                   border: `1px solid ${sleepover ? T.night : T.rule}`, background: sleepover ? T.nightBg : T.surface }}>
          <Moon size={14} color={sleepover ? T.night : T.muted} />
          <span style={{ fontSize: 13.5, color: sleepover ? T.night : T.body }}>With a sleepover after</span>
        </button>

        <Label>Or mark them as</Label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px,1fr))", gap: 6 }}>
          {[["D/O", "Day off"], ...Object.entries(LEAVE_CODES)].map(([code, name]) => (
            <button key={code} onClick={() => onSave({ kind: "code", code }, code === "D/O" ? lock : true)}
              style={{ padding: "9px 6px", borderRadius: 7, cursor: "pointer", textAlign: "center",
                       border: `1px solid ${T.rule}`, background: T.surface }}>
              <div style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 700, color: code === "D/O" ? T.muted : T.leave }}>{code}</div>
              <div style={{ fontSize: 10, color: T.muted, marginTop: 1 }}>{name}</div>
            </button>
          ))}
        </div>
        <p style={{ fontSize: 11.5, color: T.muted, marginTop: 12, lineHeight: 1.5 }}>
          Leave is locked automatically so a rebuild never rosters over it.
        </p>
      </div>
    </div>
  );
}

function StaffPanel({ data, persist, onClose }) {
  const [name, setName] = useState(""); const [role, setRole] = useState("CO");
  const upd = (id, patch) => persist({ ...data, staff: data.staff.map((s) => s.id === id ? { ...s, ...patch } : s) });
  const add = () => {
    if (!name.trim()) return;
    const id = `s${Date.now()}`;
    const av = { ...data.availability };
    for (let d = 0; d < 7; d++) av[`${id}|${d}`] = { mode: "any", shifts: [] };
    persist({ ...data, availability: av,
      staff: [...data.staff, { id, name: name.trim(), role, contractHours: 30, maxDays: 5, officeHours: false, active: true }] });
    setName("");
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(22,33,30,.35)", zIndex: 50,
            display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: T.surface, width: "100%", maxWidth: 520, maxHeight: "88vh", overflowY: "auto",
                 borderRadius: "14px 14px 0 0", padding: "18px 18px 26px", fontFamily: SANS }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 15 }}>
          <div style={{ fontSize: 17, fontWeight: 620 }}>Staff and contracts</div>
          <IconBtn onClick={onClose} label="Close"><X size={16} /></IconBtn>
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name"
            onKeyDown={(e) => e.key === "Enter" && add()}
            style={{ flex: 1, fontFamily: SANS, fontSize: 14, padding: "9px 11px", borderRadius: 7, border: `1px solid ${T.rule}` }} />
          <select value={role} onChange={(e) => setRole(e.target.value)}
            style={{ fontSize: 13, padding: "9px", borderRadius: 7, border: `1px solid ${T.rule}`, background: T.surface }}>
            {ROLES.map((r) => <option key={r}>{r}</option>)}
          </select>
          <button onClick={add} style={{ padding: "0 14px", borderRadius: 7, border: "none",
            background: T.accent, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center" }}><Plus size={16} /></button>
        </div>
        <div style={{ display: "grid", gap: 5 }}>
          {data.staff.map((s) => (
            <div key={s.id} style={{ border: `1px solid ${T.ruleSoft}`, borderRadius: 8, padding: "10px 12px", opacity: s.active ? 1 : .45 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 560 }}>{s.name}</div>
                  <div style={{ fontSize: 10, letterSpacing: ".1em", color: T.muted, textTransform: "uppercase" }}>{s.role}</div>
                </div>
                <button onClick={() => upd(s.id, { active: !s.active })}
                  style={{ fontSize: 11.5, padding: "5px 9px", borderRadius: 6, cursor: "pointer",
                           border: `1px solid ${T.rule}`, background: T.surface, color: T.body }}>
                  {s.active ? "On rota" : "Off rota"}
                </button>
              </div>
              <div style={{ display: "flex", gap: 14, marginTop: 9, alignItems: "center", flexWrap: "wrap" }}>
                <Num label="Contract hours" value={s.contractHours} onChange={(v) => upd(s.id, { contractHours: v })} step={2.5} />
                <Num label="Max days" value={s.maxDays} onChange={(v) => upd(s.id, { maxDays: v })} step={1} />
                <button onClick={() => upd(s.id, { officeHours: !s.officeHours })}
                  style={{ fontSize: 11.5, padding: "5px 9px", borderRadius: 6, cursor: "pointer",
                           border: `1px solid ${s.officeHours ? T.accent : T.rule}`,
                           background: s.officeHours ? T.accentBg : T.surface, color: s.officeHours ? T.accent : T.muted }}>
                  Office hours
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Num({ label: l, value, onChange, step }) {
  return (
    <div>
      <div style={{ fontSize: 9.5, letterSpacing: ".12em", color: T.muted, textTransform: "uppercase", marginBottom: 3 }}>{l}</div>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <Step onClick={() => onChange(Math.max(0, value - step))}>−</Step>
        <span style={{ fontFamily: MONO, fontSize: 13.5, fontWeight: 600, width: 30, textAlign: "center" }}>{value}</span>
        <Step onClick={() => onChange(value + step)}>+</Step>
      </div>
    </div>
  );
}

function Step({ children, onClick }) {
  return <button onClick={onClick} style={{ width: 24, height: 24, borderRadius: 5, cursor: "pointer",
    border: `1px solid ${T.rule}`, background: T.surface, color: T.body, fontSize: 14, lineHeight: 1 }}>{children}</button>;
}
function Btn({ children, onClick, icon: Icon }) {
  return <button onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: SANS,
    fontSize: 13, fontWeight: 500, padding: "8px 12px", borderRadius: 7, cursor: "pointer",
    border: `1px solid ${T.rule}`, background: T.surface, color: T.body }}>{Icon && <Icon size={14} />}{children}</button>;
}
function IconBtn({ children, onClick, label: l }) {
  return <button onClick={onClick} aria-label={l} style={{ width: 34, height: 34, borderRadius: 8,
    border: `1px solid ${T.rule}`, background: T.surface, color: T.body, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center" }}>{children}</button>;
}
function Label({ children }) {
  return <div style={{ fontSize: 10, letterSpacing: ".16em", color: T.muted, fontWeight: 600,
    textTransform: "uppercase", marginBottom: 7 }}>{children}</div>;
}
function Splash() {
  return <div style={{ minHeight: "100vh", background: T.paper, fontFamily: SANS, color: T.muted,
    display: "flex", alignItems: "center", justifyContent: "center" }}>Loading…</div>;
}

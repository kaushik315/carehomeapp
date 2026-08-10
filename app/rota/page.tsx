"use client";

/* ==========================================================================
   Rota Builder — availability in, rota out.
   Port of prototypes/rota-builder.jsx onto the real Postgres-backed API.
   Behaviour and UI follow the prototype; persistence goes through
   /api/rota/* instead of window.storage. See CLAUDE.md "Rota generator".
   ========================================================================== */

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft, ChevronRight, Plus, X, Wand2, Lock, Unlock, Shuffle,
  AlertTriangle, Users, CalendarRange, Sliders, Printer, RotateCcw, Moon, Info, LogOut,
} from "lucide-react";
import { DAYS, SHORT_DAYS, ROLES, LEAVE_CODES, type RotaConfig, type WeekData, type AssignmentValue, type StaffMember, type ShiftDef } from "@/lib/rota/types";
import { mondayOf, addDays, weekKey, ddmm, toMin, shiftHours, shortTime, shiftLabel } from "@/lib/rota/date-utils";

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
const ROLE_RANK = Object.fromEntries(ROLES.map((r, i) => [r, i]));

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Something went wrong (${res.status}).`);
  }
  return res.json();
}

/* ========================================================================== */

export default function RotaBuilderPage() {
  const router = useRouter();
  const [config, setConfig] = useState<RotaConfig | null>(null);
  const [week, setWeek] = useState<WeekData | null>(null);
  const [tab, setTab] = useState<"rota" | "availability" | "cover">("rota");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [seed, setSeed] = useState(1);
  const [editing, setEditing] = useState<{ staffId: string; day: number } | null>(null);
  const [staffPanel, setStaffPanel] = useState(false);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");

  const monday = useMemo(() => mondayOf(anchor), [anchor]);
  const wk = weekKey(monday);
  const dates = useMemo(() => DAYS.map((_, i) => addDays(monday, i)), [monday]);

  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 3500);
  }, []);

  const loadConfig = useCallback(async () => {
    setConfig(await api("/api/rota/config"));
  }, []);
  const loadWeek = useCallback(
    async (weekStart: string) => {
      setWeek(await api(`/api/rota/weeks/${weekStart}`));
    },
    [],
  );

  const retryInitialLoad = useCallback(() => {
    setLoadError("");
    loadConfig().catch((e) => setLoadError(e instanceof Error ? e.message : "Could not load the rota."));
    loadWeek(wk).catch((e) => setLoadError(e instanceof Error ? e.message : "Could not load the rota."));
  }, [loadConfig, loadWeek, wk]);

  useEffect(() => {
    loadConfig().catch((e) => setLoadError(e instanceof Error ? e.message : "Could not load the rota."));
  }, [loadConfig]);
  useEffect(() => {
    loadWeek(wk).catch((e) => setLoadError(e instanceof Error ? e.message : "Could not load the rota."));
  }, [wk, loadWeek]);

  const staff = useMemo(
    () =>
      (config?.staff || [])
        .filter((s) => s.isActive)
        .slice()
        .sort((a, b) => (ROLE_RANK[a.role] ?? 99) - (ROLE_RANK[b.role] ?? 99) || a.name.localeCompare(b.name)),
    [config],
  );

  const shiftBy = useMemo(() => Object.fromEntries((config?.shifts || []).map((s) => [s.key, s])), [config]);

  const build = async (useSeed?: number) => {
    const s = useSeed ?? seed;
    setSeed(s);
    setBusy(true);
    try {
      const result: WeekData = await api(`/api/rota/weeks/${wk}/build`, { method: "POST", body: JSON.stringify({ seed: s }) });
      setWeek(result);
      flash(result.unfilled.length ? `Rota built — ${result.unfilled.length} slot${result.unfilled.length > 1 ? "s" : ""} still open` : "Rota built — everything covered");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not build the rota.");
    } finally {
      setBusy(false);
    }
  };

  const saveCell = async (staffId: string, day: number, value: AssignmentValue | null) => {
    try {
      setWeek(await api(`/api/rota/weeks/${wk}`, { method: "PATCH", body: JSON.stringify({ cell: { staffId, day, value } }) }));
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not save.");
    }
  };

  const setOnCall = async (staffId: string | null) => {
    try {
      setWeek(await api(`/api/rota/weeks/${wk}`, { method: "PATCH", body: JSON.stringify({ onCallStaffId: staffId }) }));
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not save.");
    }
  };

  const unlockAll = async () => {
    try {
      setWeek(await api(`/api/rota/weeks/${wk}`, { method: "PATCH", body: JSON.stringify({ unlockAll: true }) }));
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not save.");
    }
  };

  const addStaff = async (name: string, role: string) => {
    try {
      await api("/api/rota/staff", { method: "POST", body: JSON.stringify({ name, role }) });
      await loadConfig();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not add staff.");
    }
  };

  const updateStaff = async (id: string, patch: Partial<StaffMember>) => {
    try {
      await api(`/api/rota/staff/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await loadConfig();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not save.");
    }
  };

  const setAvailability = async (staffId: string, day: number, mode: string, shifts: string[], applyToWeek = false) => {
    try {
      await api("/api/rota/availability", { method: "PUT", body: JSON.stringify({ staffId, day, mode, shifts, applyToWeek }) });
      await loadConfig();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not save.");
    }
  };

  const setDemand = async (day: number, shiftKey: string, headcount: number, applyToWeek = false) => {
    try {
      await api("/api/rota/demand", { method: "PUT", body: JSON.stringify({ day, shiftKey, headcount, applyToWeek }) });
      await loadConfig();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not save.");
    }
  };

  const handleLogout = async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    router.push("/admin/login");
    router.refresh();
  };

  const totals = useMemo(() => {
    const out: Record<string, { hours: number; days: number; so: number }> = {};
    if (!week) return out;
    staff.forEach((s) => {
      let hours = 0, days = 0, so = 0;
      for (let d = 0; d < 7; d++) {
        const a = week.assignments[`${s.id}|${d}`];
        if (!a || a.kind !== "shift") continue;
        const sh = shiftBy[a.shiftKey];
        if (!sh) continue;
        hours += shiftHours(sh);
        days += 1;
        if (a.sleepover) so += 1;
      }
      out[s.id] = { hours, days, so };
    });
    return out;
  }, [staff, week, shiftBy]);

  if (!config || !week) return <Splash error={loadError} onRetry={retryInitialLoad} />;

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
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", color: T.muted, fontWeight: 600 }}>
                Rota builder
              </div>
              <h1 style={{ fontSize: 24, fontWeight: 650, letterSpacing: "-.02em", margin: "2px 0 14px" }}>{config.tenantName}</h1>
            </div>
            <IconBtn onClick={handleLogout} label="Log out"><LogOut size={16} /></IconBtn>
          </div>

          <div style={{ display: "flex", gap: 4, marginBottom: 14, borderBottom: `1px solid ${T.rule}` }}>
            {([
              ["rota", "Rota", CalendarRange],
              ["availability", "Who can work when", Users],
              ["cover", "Cover needed", Sliders],
            ] as const).map(([k, lbl, Icon]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 13px", fontSize: 13.5,
                  fontFamily: SANS, cursor: "pointer", border: "none", background: "transparent",
                  color: tab === k ? T.accent : T.muted, fontWeight: tab === k ? 600 : 500,
                  borderBottom: `2px solid ${tab === k ? T.accent : "transparent"}`, marginBottom: -1,
                }}
              >
                <Icon size={14} />{lbl}
              </button>
            ))}
          </div>
        </header>

        {toast && (
          <div className="no-print" style={{ background: T.accentBg, color: T.accent, padding: "9px 12px", borderRadius: 7, fontSize: 13, marginBottom: 12, display: "flex", gap: 7, alignItems: "center" }}>
            <Info size={14} />{toast}
          </div>
        )}

        {tab === "rota" && (
          <RotaTab
            config={config} staff={staff} shiftBy={shiftBy} week={week} dates={dates} monday={monday}
            setAnchor={setAnchor} totals={totals} build={build} busy={busy} seed={seed}
            onEdit={setEditing} openStaff={() => setStaffPanel(true)} setOnCall={setOnCall} unlockAll={unlockAll}
          />
        )}
        {tab === "availability" && <AvailabilityTab config={config} staff={staff} setAvailability={setAvailability} openStaff={() => setStaffPanel(true)} />}
        {tab === "cover" && <CoverTab config={config} setDemand={setDemand} />}
      </div>

      {editing && (
        <CellEditor
          staff={config.staff.find((s) => s.id === editing.staffId)!}
          day={editing.day}
          date={dates[editing.day]}
          shifts={config.shifts}
          value={week.assignments[`${editing.staffId}|${editing.day}`]}
          onSave={(v, lock) => {
            saveCell(editing.staffId, editing.day, v ? { ...v, locked: lock } : null);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {staffPanel && <StaffPanel config={config} addStaff={addStaff} updateStaff={updateStaff} onClose={() => setStaffPanel(false)} />}
    </div>
  );
}

/* ---------------------------- ROTA TAB ---------------------------- */
function RotaTab({
  config, staff, shiftBy, week, dates, monday, setAnchor, totals, build, busy, seed, onEdit, openStaff, setOnCall, unlockAll,
}: {
  config: RotaConfig; staff: StaffMember[]; shiftBy: Record<string, ShiftDef>; week: WeekData; dates: Date[]; monday: Date;
  setAnchor: (d: Date) => void; totals: Record<string, { hours: number; days: number; so: number }>;
  build: (seed?: number) => void; busy: boolean; seed: number;
  onEdit: (v: { staffId: string; day: number }) => void; openStaff: () => void;
  setOnCall: (staffId: string | null) => void; unlockAll: () => void;
}) {
  const lockedCount = Object.values(week.assignments).filter((a) => a.locked).length;

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
        <button
          onClick={() => build(seed)}
          disabled={busy}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 16px", borderRadius: 8, border: "none", background: T.accent, color: "#fff", fontSize: 14, fontWeight: 600, fontFamily: SANS, cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1 }}
        >
          <Wand2 size={15} />{week.built ? "Build again" : "Build the rota"}
        </button>
        {week.built && <Btn onClick={() => build(Math.floor(Math.random() * 99999))} icon={Shuffle}>Try a different one</Btn>}
        <Btn onClick={openStaff} icon={Users}>Staff</Btn>
        <Btn onClick={() => window.print()} icon={Printer}>Print</Btn>
        {lockedCount > 0 && <Btn onClick={unlockAll} icon={RotateCcw}>Unlock all ({lockedCount})</Btn>}
      </div>

      {!week.built && (
        <div style={{ background: T.surface, border: `1px dashed ${T.rule}`, borderRadius: 10, padding: "34px 22px", textAlign: "center", marginBottom: 16 }}>
          <Wand2 size={26} color={T.accent} />
          <div style={{ fontSize: 15.5, fontWeight: 600, marginTop: 10 }}>No rota for this week yet</div>
          <p style={{ fontSize: 13, color: T.muted, maxWidth: 400, margin: "6px auto 0", lineHeight: 1.55 }}>
            Check availability and cover on the other two tabs, then build. Anything you change afterwards can be locked so the next build works around it.
          </p>
        </div>
      )}

      {week.built && (
        <>
          {week.unfilled.length > 0 && (
            <div style={{ marginBottom: 14, border: `1px solid ${T.alertBg}`, borderRadius: 10, overflow: "hidden" }}>
              <div style={{ background: T.alertBg, color: T.alert, padding: "9px 13px", fontSize: 12.5, fontWeight: 600, display: "flex", gap: 7, alignItems: "center" }}>
                <AlertTriangle size={14} />{week.unfilled.length} slot{week.unfilled.length > 1 ? "s" : ""} could not be filled
              </div>
              <div style={{ background: T.surface }}>
                {week.unfilled.map((u, i) => (
                  <div key={i} style={{ padding: "10px 13px", borderTop: i ? `1px solid ${T.ruleSoft}` : "none", fontSize: 13 }}>
                    <strong style={{ fontWeight: 600 }}>{SHORT_DAYS[u.day]} · {u.shiftName}</strong>
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
                        <div style={{ fontSize: 10, letterSpacing: ".14em" }}>{SHORT_DAYS[i].toUpperCase()}</div>
                        <div style={{ fontFamily: MONO, fontSize: 11.5, color: T.muted, fontWeight: 500 }}>{ddmm(dates[i])}</div>
                      </th>
                    ))}
                    <th style={{ ...th, minWidth: 74 }}>HOURS</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((s, idx) => {
                    const bg = idx % 2 ? "#FCFDFC" : T.surface;
                    const t = totals[s.id] || { hours: 0, days: 0, so: 0 };
                    const short = t.hours < (s.contractHours || 0) - 0.5;
                    return (
                      <tr key={s.id} style={{ background: bg }}>
                        <td style={{ ...td, position: "sticky", left: 0, background: bg, zIndex: 1, borderRight: `1px solid ${T.rule}` }}>
                          <div style={{ fontSize: 14, fontWeight: 560 }}>{s.name}</div>
                          <div style={{ fontSize: 10, letterSpacing: ".1em", color: T.muted, textTransform: "uppercase" }}>{s.role}</div>
                        </td>
                        {DAYS.map((_, d) => (
                          <td key={d} style={{ ...td, padding: 0 }}>
                            <Cell a={week.assignments[`${s.id}|${d}`]} shiftBy={shiftBy} onClick={() => onEdit({ staffId: s.id, day: d })} />
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

            <div style={{ borderTop: `1px solid ${T.rule}`, padding: "11px 15px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, letterSpacing: ".16em", color: T.muted, fontWeight: 600 }}>ON CALL</span>
              <select
                value={week.onCallStaffId || ""}
                onChange={(e) => setOnCall(e.target.value || null)}
                style={{ fontFamily: SANS, fontSize: 14, padding: "5px 9px", borderRadius: 6, border: `1px solid ${T.rule}`, background: T.surface, color: T.ink }}
              >
                <option value="">Nobody set</option>
                {config.staff.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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
function AvailabilityTab({
  config, staff, setAvailability, openStaff,
}: {
  config: RotaConfig; staff: StaffMember[];
  setAvailability: (staffId: string, day: number, mode: string, shifts: string[], applyToWeek?: boolean) => void;
  openStaff: () => void;
}) {
  const cycle = (staffId: string, day: number) => {
    const cur = config.availability[`${staffId}|${day}`] || { mode: "any" as const, shifts: [] };
    const next = cur.mode === "any" ? "shifts" : cur.mode === "shifts" ? "off" : "any";
    setAvailability(staffId, day, next, next === "shifts" ? (cur.shifts.length ? cur.shifts : ["early"]) : cur.shifts);
  };
  const toggleShift = (staffId: string, day: number, key: string) => {
    const cur = config.availability[`${staffId}|${day}`] || { mode: "shifts" as const, shifts: [] };
    const shifts = cur.shifts.includes(key) ? cur.shifts.filter((k) => k !== key) : [...cur.shifts, key];
    setAvailability(staffId, day, "shifts", shifts);
  };
  const applyAll = (staffId: string, day: number) => {
    const cur = config.availability[`${staffId}|${day}`] || { mode: "any" as const, shifts: [] };
    setAvailability(staffId, day, cur.mode, cur.shifts, true);
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
              <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 12, color: T.muted }}>{s.contractHours}h · max {s.maxDays} days</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5 }}>
              {DAYS.map((_, d) => {
                const av = config.availability[`${s.id}|${d}`] || { mode: "any" as const, shifts: [] };
                const tone = av.mode === "off" ? { fg: T.muted, bg: T.paper, bd: T.rule } : av.mode === "shifts" ? { fg: T.night, bg: T.nightBg, bd: T.night } : { fg: T.accent, bg: T.accentBg, bd: T.accent };
                return (
                  <div key={d}>
                    <button
                      onClick={() => cycle(s.id, d)}
                      onDoubleClick={() => applyAll(s.id, d)}
                      title="Tap to change · double tap to copy to the whole week"
                      style={{ width: "100%", padding: "7px 2px", borderRadius: 6, cursor: "pointer", border: `1px solid ${tone.bd}`, background: tone.bg, color: tone.fg, fontSize: 10.5, fontWeight: 600, letterSpacing: ".06em" }}
                    >
                      <div style={{ fontSize: 10, opacity: 0.75 }}>{SHORT_DAYS[d].toUpperCase()}</div>
                      <div style={{ marginTop: 2 }}>{av.mode === "off" ? "OFF" : av.mode === "any" ? "ANY" : "SOME"}</div>
                    </button>
                    {av.mode === "shifts" && (
                      <div style={{ display: "grid", gap: 2, marginTop: 3 }}>
                        {config.shifts.map((sh) => {
                          const on = av.shifts.includes(sh.key);
                          return (
                            <button
                              key={sh.key}
                              onClick={() => toggleShift(s.id, d, sh.key)}
                              style={{ fontFamily: MONO, fontSize: 9, padding: "3px 1px", borderRadius: 4, cursor: "pointer", border: `1px solid ${on ? T.night : T.ruleSoft}`, background: on ? T.night : T.surface, color: on ? "#fff" : T.muted }}
                            >
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
function CoverTab({ config, setDemand }: { config: RotaConfig; setDemand: (day: number, shiftKey: string, headcount: number, applyToWeek?: boolean) => void }) {
  const rows = [...config.shifts.map((s) => ({ key: s.key, name: s.name, sub: shiftLabel(s) })), { key: "sleepover", name: "Sleepover", sub: "stays until 07:00" }];

  return (
    <>
      <p style={{ fontSize: 13, color: T.body, lineHeight: 1.55, marginBottom: 14, maxWidth: 620 }}>
        How many people you need on each shift. The builder will not go below these numbers — if it cannot reach them it leaves the slot open and tells you why.
      </p>
      <div style={{ background: T.surface, border: `1px solid ${T.rule}`, borderRadius: 10, overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", minWidth: 140 }}>SHIFT</th>
              {DAYS.map((d, i) => <th key={d} style={{ ...th, minWidth: 64 }}>{SHORT_DAYS[i].toUpperCase()}</th>)}
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
                      <Step onClick={() => setDemand(d, r.key, Math.max(0, (config.demand[d]?.[r.key] || 0) - 1))}>−</Step>
                      <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, width: 16 }}>{config.demand[d]?.[r.key] ?? 0}</span>
                      <Step onClick={() => setDemand(d, r.key, (config.demand[d]?.[r.key] || 0) + 1)}>+</Step>
                    </div>
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td style={{ ...td, borderRight: `1px solid ${T.rule}`, fontSize: 12, color: T.muted }}>Copy a day across</td>
              {DAYS.map((_, d) => (
                <td key={d} style={{ ...td, textAlign: "center" }}>
                  <button
                    onClick={() => rows.forEach((r) => setDemand(d, r.key, config.demand[d]?.[r.key] ?? 0, true))}
                    style={{ fontSize: 11, padding: "4px 8px", borderRadius: 5, cursor: "pointer", border: `1px solid ${T.rule}`, background: T.surface, color: T.body }}
                  >
                    copy
                  </button>
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
const th = { padding: "9px 7px", textAlign: "center" as const, borderBottom: `1.5px solid ${T.rule}`, fontWeight: 600, color: T.body, textTransform: "uppercase" as const, fontSize: 10, letterSpacing: ".14em", verticalAlign: "bottom" as const };
const td = { padding: "7px 8px", borderBottom: `1px solid ${T.ruleSoft}`, verticalAlign: "middle" as const };

function Cell({ a, shiftBy, onClick }: { a: AssignmentValue | undefined; shiftBy: Record<string, ShiftDef>; onClick: () => void }) {
  let inner;
  if (!a) inner = <span style={{ color: T.rule, fontSize: 17 }}>+</span>;
  else if (a.kind === "code") {
    const isOff = a.code === "D/O";
    inner = (
      <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: isOff ? T.muted : a.code === "IN" ? T.accent : T.leave, background: isOff ? "transparent" : a.code === "IN" ? T.accentBg : T.leaveBg, padding: isOff ? 0 : "2px 6px", borderRadius: 4 }}>
        {a.code}
      </span>
    );
  } else {
    const sh = shiftBy[a.shiftKey];
    const night = Boolean(sh && (toMin(sh.start) >= 1200 || toMin(sh.end) <= toMin(sh.start)));
    inner = (
      <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
        <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: night ? T.night : T.ink }}>{sh ? shiftLabel(sh) : "?"}</span>
        {a.sleepover && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9, fontWeight: 700, color: T.night, background: T.nightBg, padding: "1px 5px", borderRadius: 3 }}>
            <Moon size={8} /> S/O
          </span>
        )}
      </span>
    );
  }
  return (
    <button className="cellbtn" onClick={onClick} style={{ width: "100%", minHeight: 50, border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", padding: "6px 4px" }}>
      {inner}
      {a?.locked && <Lock size={9} color={T.accent} style={{ position: "absolute", top: 4, right: 4 }} />}
    </button>
  );
}

function CellEditor({
  staff, day, date, shifts, value, onClose, onSave,
}: {
  staff: StaffMember; day: number; date: Date; shifts: ShiftDef[]; value: AssignmentValue | undefined;
  onClose: () => void; onSave: (v: { kind: "shift"; shiftKey: string; sleepover: boolean } | { kind: "code"; code: string } | null, lock: boolean) => void;
}) {
  const [lock, setLock] = useState(Boolean(value?.locked));
  const [sleepover, setSleepover] = useState(value?.kind === "shift" ? value.sleepover : false);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(22,33,30,.35)", zIndex: 50, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: T.surface, width: "100%", maxWidth: 500, maxHeight: "88vh", overflowY: "auto", borderRadius: "14px 14px 0 0", padding: "18px 18px 26px", fontFamily: SANS }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 15 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 620 }}>{staff.name}</div>
            <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>{DAYS[day]} {ddmm(date)}</div>
          </div>
          <IconBtn onClick={onClose} label="Close"><X size={16} /></IconBtn>
        </div>

        <button
          onClick={() => setLock(!lock)}
          style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "10px 12px", marginBottom: 16, borderRadius: 8, cursor: "pointer", textAlign: "left", border: `1px solid ${lock ? T.accent : T.rule}`, background: lock ? T.accentBg : T.surface }}
        >
          {lock ? <Lock size={15} color={T.accent} /> : <Unlock size={15} color={T.muted} />}
          <span style={{ flex: 1, fontSize: 13.5, color: lock ? T.accent : T.body }}>Keep this when the rota is built again</span>
        </button>

        <Label>Put them on</Label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px,1fr))", gap: 6, marginBottom: 8 }}>
          {shifts.map((sh) => (
            <button
              key={sh.key}
              onClick={() => onSave({ kind: "shift", shiftKey: sh.key, sleepover }, lock)}
              style={{ padding: "9px 6px", borderRadius: 7, cursor: "pointer", textAlign: "center", border: `1px solid ${value?.kind === "shift" && value.shiftKey === sh.key ? T.accent : T.rule}`, background: value?.kind === "shift" && value.shiftKey === sh.key ? T.accentBg : T.surface }}
            >
              <div style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600 }}>{shiftLabel(sh)}</div>
              <div style={{ fontSize: 10, color: T.muted, marginTop: 1 }}>{sh.name}</div>
            </button>
          ))}
        </div>

        <button
          onClick={() => setSleepover(!sleepover)}
          style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 12px", marginBottom: 18, borderRadius: 8, cursor: "pointer", textAlign: "left", border: `1px solid ${sleepover ? T.night : T.rule}`, background: sleepover ? T.nightBg : T.surface }}
        >
          <Moon size={14} color={sleepover ? T.night : T.muted} />
          <span style={{ fontSize: 13.5, color: sleepover ? T.night : T.body }}>With a sleepover after</span>
        </button>

        <Label>Or mark them as</Label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px,1fr))", gap: 6 }}>
          {[["D/O", "Day off"], ...Object.entries(LEAVE_CODES)].map(([code, name]) => (
            <button
              key={code}
              onClick={() => onSave({ kind: "code", code }, code === "D/O" ? lock : true)}
              style={{ padding: "9px 6px", borderRadius: 7, cursor: "pointer", textAlign: "center", border: `1px solid ${T.rule}`, background: T.surface }}
            >
              <div style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 700, color: code === "D/O" ? T.muted : T.leave }}>{code}</div>
              <div style={{ fontSize: 10, color: T.muted, marginTop: 1 }}>{name}</div>
            </button>
          ))}
        </div>
        <p style={{ fontSize: 11.5, color: T.muted, marginTop: 12, lineHeight: 1.5 }}>Leave is locked automatically so a rebuild never rosters over it.</p>
      </div>
    </div>
  );
}

function StaffPanel({
  config, addStaff, updateStaff, onClose,
}: {
  config: RotaConfig; addStaff: (name: string, role: string) => void; updateStaff: (id: string, patch: Partial<StaffMember>) => void; onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("CO");

  const add = () => {
    if (!name.trim()) return;
    addStaff(name.trim(), role);
    setName("");
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(22,33,30,.35)", zIndex: 50, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: T.surface, width: "100%", maxWidth: 520, maxHeight: "88vh", overflowY: "auto", borderRadius: "14px 14px 0 0", padding: "18px 18px 26px", fontFamily: SANS }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 15 }}>
          <div style={{ fontSize: 17, fontWeight: 620 }}>Staff and contracts</div>
          <IconBtn onClick={onClose} label="Close"><X size={16} /></IconBtn>
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            onKeyDown={(e) => e.key === "Enter" && add()}
            style={{ flex: 1, fontFamily: SANS, fontSize: 14, padding: "9px 11px", borderRadius: 7, border: `1px solid ${T.rule}` }}
          />
          <select value={role} onChange={(e) => setRole(e.target.value)} style={{ fontSize: 13, padding: "9px", borderRadius: 7, border: `1px solid ${T.rule}`, background: T.surface }}>
            {ROLES.map((r) => <option key={r}>{r}</option>)}
          </select>
          <button onClick={add} style={{ padding: "0 14px", borderRadius: 7, border: "none", background: T.accent, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center" }}>
            <Plus size={16} />
          </button>
        </div>
        <div style={{ display: "grid", gap: 5 }}>
          {config.staff.map((s) => (
            <div key={s.id} style={{ border: `1px solid ${T.ruleSoft}`, borderRadius: 8, padding: "10px 12px", opacity: s.isActive ? 1 : 0.45 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 560 }}>{s.name}</div>
                  <div style={{ fontSize: 10, letterSpacing: ".1em", color: T.muted, textTransform: "uppercase" }}>{s.role}</div>
                </div>
                <button
                  onClick={() => updateStaff(s.id, { isActive: !s.isActive })}
                  style={{ fontSize: 11.5, padding: "5px 9px", borderRadius: 6, cursor: "pointer", border: `1px solid ${T.rule}`, background: T.surface, color: T.body }}
                >
                  {s.isActive ? "On rota" : "Off rota"}
                </button>
              </div>
              <div style={{ display: "flex", gap: 14, marginTop: 9, alignItems: "center", flexWrap: "wrap" }}>
                <Num label="Contract hours" value={s.contractHours} onChange={(v) => updateStaff(s.id, { contractHours: v })} step={2.5} />
                <Num label="Max days" value={s.maxDays} onChange={(v) => updateStaff(s.id, { maxDays: v })} step={1} />
                <button
                  onClick={() => updateStaff(s.id, { officeHours: !s.officeHours })}
                  style={{ fontSize: 11.5, padding: "5px 9px", borderRadius: 6, cursor: "pointer", border: `1px solid ${s.officeHours ? T.accent : T.rule}`, background: s.officeHours ? T.accentBg : T.surface, color: s.officeHours ? T.accent : T.muted }}
                >
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

function Num({ label: l, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step: number }) {
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

function Step({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ width: 24, height: 24, borderRadius: 5, cursor: "pointer", border: `1px solid ${T.rule}`, background: T.surface, color: T.body, fontSize: 14, lineHeight: 1 }}>
      {children}
    </button>
  );
}
function Btn({ children, onClick, icon: Icon }: { children: React.ReactNode; onClick: () => void; icon?: React.ComponentType<{ size?: number }> }) {
  return (
    <button onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: SANS, fontSize: 13, fontWeight: 500, padding: "8px 12px", borderRadius: 7, cursor: "pointer", border: `1px solid ${T.rule}`, background: T.surface, color: T.body }}>
      {Icon && <Icon size={14} />}{children}
    </button>
  );
}
function IconBtn({ children, onClick, label: l }: { children: React.ReactNode; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={l} style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${T.rule}`, background: T.surface, color: T.body, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {children}
    </button>
  );
}
function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, letterSpacing: ".16em", color: T.muted, fontWeight: 600, textTransform: "uppercase", marginBottom: 7 }}>{children}</div>;
}
function Splash({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <div style={{ minHeight: "100vh", background: T.paper, fontFamily: SANS, color: T.muted, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {error ? (
        <div style={{ maxWidth: 420, textAlign: "center", padding: 24 }}>
          <div style={{ color: T.alert, fontWeight: 600, marginBottom: 8 }}>Could not load the rota</div>
          <div style={{ fontSize: 13, color: T.body, marginBottom: 16, lineHeight: 1.5 }}>{error}</div>
          {onRetry && (
            <button
              onClick={onRetry}
              style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: T.accent, color: "#fff", fontSize: 14, fontWeight: 600, fontFamily: SANS, cursor: "pointer" }}
            >
              Try again
            </button>
          )}
        </div>
      ) : (
        "Loading…"
      )}
    </div>
  );
}
